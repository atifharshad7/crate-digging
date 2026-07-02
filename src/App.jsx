import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";

/*
  Crate Digging — find records in Berlin shops (in-store pickup only)
  Two roles: buyer (search / reserve) and owner (add / edit / update stock).

  Data lives in Supabase (shared across everyone):
    profiles      -> account: name, role (buyer|owner), shop_id, saved[]
    shops         -> a record shop (owner_id links to its owner)
    releases      -> catalog metadata: artist, title, cover, image, tracklist
    listings      -> one physical copy at one shop (price, condition, status)
    reservations  -> a buyer holds a copy for in-store pickup
  Auth is Supabase Auth (real email + password). Row Level Security enforces
  that a shop owner can only edit their own stock.
*/

// map snake_case DB rows -> the camelCase shapes the UI already uses
const mapShop = (s) => ({ id: s.id, name: s.name, hood: s.hood, address: s.address, lat: s.lat, lng: s.lng, discogs: s.discogs, mapsUrl: s.maps_url, holdHours: s.hold_hours == null ? 48 : s.hold_hours, vinylColor: s.vinyl_color || null, owner_id: s.owner_id });
const mapRelease = (r) => ({ id: r.id, artist: r.artist, title: r.title, year: r.year, genre: r.genre, format: r.format, cover: r.cover || ["#38271F", "#C4632E"], image: r.image || undefined, youtubeUrl: r.youtube_url || undefined, tracklist: r.tracklist || undefined, discogsId: r.discogs_release_id || undefined });
const mapListing = (l) => ({ id: l.id, shopId: l.shop_id, releaseId: l.release_id, condition: l.condition, price: l.price, qty: l.qty, status: l.status, source: l.source, discount: l.discount || undefined, updated: l.updated_at, created: l.created_at });
const mapReservation = (r) => ({ id: r.id, listingId: r.listing_id, releaseId: r.release_id, shopId: r.shop_id, buyerId: r.buyer_id, status: r.status, holdUntil: r.hold_until || undefined, created: r.created_at });
const mapMessage = (m) => ({ id: m.id, shopId: m.shop_id, buyerId: m.buyer_id, sender: m.sender, senderName: m.sender_name || undefined, body: m.body, created: m.created_at });

// minimal CSV parser: expects columns artist, title, price (header optional)
function parseCSV(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length);
  if (!lines.length) return [];
  const splitLine = (line) => {
    const out = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  let cols = ["artist", "title", "price"]; let start = 0;
  const first = splitLine(lines[0]).map((s) => s.toLowerCase());
  if (first.includes("artist") && first.includes("title")) { cols = first; start = 1; }
  const ai = cols.indexOf("artist"), ti = cols.indexOf("title"), pi = cols.indexOf("price");
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const c = splitLine(lines[i]);
    const artist = (ai >= 0 ? c[ai] : c[0]) || "";
    const title = (ti >= 0 ? c[ti] : c[1]) || "";
    const price = ((pi >= 0 ? c[pi] : c[2]) || "").replace(/[^\d.]/g, "");
    if (artist.trim() && title.trim()) rows.push({ artist: artist.trim(), title: title.trim(), price });
  }
  return rows;
}

// recent emails for the login screen stay on the device (a convenience, not shared data)
const getRecentEmails = () => { try { return JSON.parse(localStorage.getItem("cd:recent_emails") || "[]"); } catch { return []; } };
const putRecentEmails = (list) => { try { localStorage.setItem("cd:recent_emails", JSON.stringify(list)); } catch { /* ignore */ } };
const getMsgSeen = () => { try { return JSON.parse(localStorage.getItem("cd:msg_seen") || "{}"); } catch { return {}; } };
const putMsgSeen = (map) => { try { localStorage.setItem("cd:msg_seen", JSON.stringify(map)); } catch { /* ignore */ } };


const CONDITIONS = ["M", "NM", "VG+", "VG", "G"];
const STATUS_NEXT = { available: "reserved", reserved: "sold", sold: "available" };
const STATUS_COLORS = {
  available: { bg: "#13251B", fg: "#7FCBA0" },
  pending: { bg: "#15222E", fg: "#7FB0DE" },
  reserved: { bg: "#2A2416", fg: "#D8B15E" },
  sold: { bg: "#202020", fg: "#8A8A8A" },
};

// ---- tiny presentational helpers ----
function fileToScaledDataURL(file, max = 480) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function Sleeve({ release, size = 48 }) {
  const [bg, accent] = release?.cover || ["#38271F", "#C4632E"];
  if (release?.image) {
    return <img src={release.image} alt="" style={{ width: size, height: size, borderRadius: 4, objectFit: "cover", flexShrink: 0, display: "block" }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: 4, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <div style={{ width: size * 0.46, height: size * 0.46, borderRadius: "50%", background: accent }} />
    </div>
  );
}

function Disc({ size = 150, label = "#BF5227", spin = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <g className={spin ? "spin" : ""} style={{ transformBox: "view-box", transformOrigin: "50px 50px" }}>
        <circle cx="50" cy="50" r="48" fill="#1C1C1C" />
        {[42, 36, 30, 24].map((r) => (
          <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="#3A3A3A" strokeWidth="0.4" />
        ))}
        <circle cx="50" cy="50" r="15" fill="none" stroke={label} strokeWidth="2.5" opacity="0.85" />
        <circle cx="50" cy="50" r="3" fill="#0F0F0F" />
        <circle cx="41" cy="41" r="1.4" fill="#0F0F0F" opacity="0.5" />
      </g>
      <g className={spin ? "tonearm-play" : ""} style={{ transformBox: "view-box", transformOrigin: "80px 15px" }}>
        <line x1="80" y1="15" x2="63" y2="63" stroke="#5A5A5A" strokeWidth="3" strokeLinecap="round" />
        <line x1="80" y1="15" x2="63" y2="63" stroke="#9A9A9A" strokeWidth="1" strokeLinecap="round" />
        <circle cx="80" cy="15" r="6" fill="#333" stroke="#565656" strokeWidth="1" />
        <circle cx="80" cy="15" r="2" fill="#1C1C1C" />
        <g transform="translate(34,34.8) scale(0.6)">
          <path d="M 50 62 L 43.6 49.4 A 9 9 0 1 1 56.4 49.4 Z" fill="#F2F2F2" />
          <circle cx="50" cy="43" r="3.4" fill="#1C1C1C" />
        </g>
      </g>
    </svg>
  );
}

const VINYL_COLORS = [
  { id: "rust", hex: "#E0673C" }, { id: "teal", hex: "#5DCAA5" },
  { id: "gold", hex: "#E0A13C" }, { id: "blue", hex: "#7FB2E8" },
  { id: "plum", hex: "#B08AD8" }, { id: "crimson", hex: "#E24B4A" },
  { id: "green", hex: "#B4C47F" }, { id: "bone", hex: "#D8D2C4" },
];
const DEFAULT_VINYL = "#E0673C";

// map a (possibly fine-grained) genre to a browse-tile motion class.
// Anything not matched here falls back to a normal spin.
function genreMotionClass(genre) {
  const g = (genre || "").toLowerCase();
  if (g.includes("schranz") || g.includes("gabber") || g.includes("hardcore") || g.includes("hard techno") || g.includes("hardstyle")) return "gm-shakehard";
  if (g.includes("techno") || g.includes("industrial") || g.includes("ebm")) return "gm-shake";
  if (g.includes("drum") || g.includes("dnb") || g.includes("jungle") || g.includes("break")) return "gm-jolt";
  if (g.includes("afro")) return "gm-afro";
  if (g.includes("house") || g.includes("disco") || g.includes("garage")) return "gm-house";
  if (g.includes("trance") || g.includes("prog")) return "gm-prog";
  if (g.includes("ambient") || g.includes("drone") || g.includes("downtempo") || g.includes("chill")) return "gm-drift";
  if (g.includes("dub") || g.includes("reggae") || g.includes("dancehall") || g.includes("ska")) return "gm-wobble";
  if (g.includes("jazz") || g.includes("blues")) return "gm-sway";
  if (g.includes("funk") || g.includes("soul") || g.includes("r&b") || g.includes("rnb") || g.includes("motown")) return "gm-groove";
  if (g.includes("rap") || g.includes("trap")) return "gm-nod";
  if (g.includes("hip")) return "gm-pulse";
  if (g.includes("rock") || g.includes("metal") || g.includes("punk") || g.includes("grunge") || g.includes("indie")) return "gm-bob";
  if (g.includes("pop")) return "gm-bounce";
  return "gm-spin";
}

// small record (no tonearm) that animates to its genre, for browse tiles
function GenreDisc({ genre, ring = "#E0673C", size = 44 }) {
  return (
    <svg className={genreMotionClass(genre)} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true"
      style={{ transformBox: "view-box", transformOrigin: "50px 50px" }}>
      <circle cx="50" cy="50" r="48" fill="#1C1C1C" />
      <circle cx="50" cy="50" r="34" fill="none" stroke="#3A3A3A" strokeWidth="0.7" />
      <circle cx="50" cy="50" r="22" fill="none" stroke="#3A3A3A" strokeWidth="0.7" />
      <circle cx="50" cy="50" r="13" fill="none" stroke={ring} strokeWidth="3" />
      <circle cx="50" cy="50" r="3" fill="#0F0F0F" />
      <circle cx="41" cy="41" r="1.4" fill="#0F0F0F" opacity="0.6" />
    </svg>
  );
}

function StatusPill({ status, onClick }) {
  const c = STATUS_COLORS[status];
  const label = status[0].toUpperCase() + status.slice(1);
  return (
    <span
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg, cursor: onClick ? "pointer" : "default" }}
    >
      {label}
      {onClick && <span style={{ fontSize: 10 }}>▾</span>}
    </span>
  );
}

function SourceBadge({ source }) {
  const map = { discogs: { bg: "#1E242C", fg: "#9BB0C6", t: "Discogs" }, manual: { bg: "#2A1D14", fg: "#E0955F", t: "Added by you" } };
  const s = map[source] || map.manual;
  return <span style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999, background: s.bg, color: s.fg }}>{s.t}</span>;
}

const effPrice = (l) => (l.discount && l.discount.pct ? Math.round(l.price * (1 - l.discount.pct / 100)) : l.price);
const joinDot = (arr) => arr.filter((x) => x !== null && x !== undefined && String(x).trim() !== "").join(" · ");
const fmtCountdown = (until, nowMs) => {
  const ms = new Date(until).getTime() - nowMs;
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

function PriceTag({ listing, size = 16 }) {
  const has = listing.discount && listing.discount.pct;
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      {has ? <span style={{ textDecoration: "line-through", color: "var(--faint)", fontSize: size - 3, marginRight: 5 }}>€{listing.price}</span> : null}
      <span style={{ fontSize: size, fontWeight: 600, color: "var(--rust)" }}>€{effPrice(listing)}</span>
    </span>
  );
}

function DiscountBadge({ listing }) {
  if (!listing.discount) return null;
  const parts = [];
  if (listing.discount.pct) parts.push("−" + listing.discount.pct + "%");
  if (listing.discount.label) parts.push(listing.discount.label);
  if (!parts.length) return null;
  return <span style={{ fontSize: 11, color: "var(--rust)", background: "rgba(224,103,60,0.15)", padding: "2px 8px", borderRadius: 999 }}>{parts.join(" · ")}</span>;
}

const rel = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return d + "d ago";
};
const ytLink = (r) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(`${r.artist} ${r.title} vinyl`);

const USER_LOC = { lat: 52.508, lng: 13.404 };
function distanceKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ---- auth screen (login / register) ----
function AuthScreen({ authTab, setAuthTab, recentEmails, onLogin, onRegister, reason, onBack, initialRole }) {
  const [email, setEmail] = useState((recentEmails && recentEmails[0]) || "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState(initialRole || "buyer");
  const [newShop, setNewShop] = useState({ name: "", hood: "", address: "", mapsUrl: "", vinylColor: "#E0673C" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [emailFocus, setEmailFocus] = useState(false);

  const isLogin = authTab === "login";

  const q = email.trim().toLowerCase();
  const suggestions = (recentEmails || []).filter((e) => e !== q && e.includes(q)).slice(0, 5);

  const submit = async () => {
    if (busy) return;
    setErr(null); setBusy(true);
    const e = isLogin
      ? await onLogin(email, password)
      : await onRegister({ name, email, password, role, newShop: role === "owner" ? newShop : null });
    setBusy(false);
    if (e) setErr(e);
  };

  return (
    <div className="rille" style={{ minHeight: "100dvh", background: "#000000", display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 393, background: "var(--cream)", minHeight: "100dvh", display: "flex", flexDirection: "column", padding: "0 22px" }}>
        {onBack && (
          <div style={{ paddingTop: 14 }}>
            <span role="button" onClick={onBack} className="k" style={{ cursor: "pointer", fontSize: 14 }}>‹ Back to browsing</span>
          </div>
        )}
        <div style={{ textAlign: "center", paddingTop: onBack ? 24 : 48 }}>
          <Disc size={72} spin />
          <div className="serif" style={{ fontSize: 26, fontWeight: 600, marginTop: 10 }}>Crate Digging</div>
          <div className="k" style={{ marginTop: 4 }}>Find the record, find the shop.</div>
          {reason && <div style={{ marginTop: 14, fontSize: 14, color: "var(--rust)" }}>Create a free account {reason}.</div>}
        </div>

        <div className="modeseg" style={{ marginTop: 32 }}>
          <button className={isLogin ? "on" : ""} onClick={() => { setAuthTab("login"); setErr(null); }}>Log in</button>
          <button className={!isLogin ? "on" : ""} onClick={() => { setAuthTab("register"); setErr(null); }}>Sign up</button>
        </div>

        <div style={{ marginTop: 22 }}>
          {!isLogin && (
            <input className="field" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 10 }} />
          )}
          <div style={{ position: "relative", marginBottom: 10 }}>
            <input className="field" placeholder="Email" type="email" autoComplete="username" value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setEmailFocus(true)}
              onBlur={() => setTimeout(() => setEmailFocus(false), 120)} />
            {emailFocus && suggestions.length > 0 && (
              <div className="card" style={{ marginTop: 6 }}>
                {suggestions.map((e, i) => (
                  <div key={e} onMouseDown={() => { setEmail(e); setEmailFocus(false); }} role="button"
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", cursor: "pointer", borderTop: i ? "0.5px solid var(--line)" : "none", fontSize: 14 }}>
                    <span style={{ color: "var(--faint)" }}>◷</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{e}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <input className="field" placeholder="Password" type="password" autoComplete={isLogin ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />

          {!isLogin && (
            <>
              <div className="k" style={{ margin: "18px 0 6px" }}>I'm here to</div>
              <div className="seg">
                <div className={"segi" + (role === "buyer" ? " on" : "")} onClick={() => setRole("buyer")}>Buy records</div>
                <div className={"segi" + (role === "owner" ? " on" : "")} onClick={() => setRole("owner")}>Run a shop</div>
              </div>

              {role === "owner" && (
                <div style={{ marginTop: 14 }}>
                  <div className="k" style={{ marginBottom: 6 }}>Your shop</div>
                  <input className="field" placeholder="Shop name" value={newShop.name} onChange={(e) => setNewShop({ ...newShop, name: e.target.value })} style={{ marginBottom: 10 }} />
                  <input className="field" placeholder="Neighborhood (e.g. Kreuzberg)" value={newShop.hood} onChange={(e) => setNewShop({ ...newShop, hood: e.target.value })} style={{ marginBottom: 10 }} />
                  <input className="field" placeholder="Address (e.g. Oranienstraße 12, 10999 Berlin)" value={newShop.address} onChange={(e) => setNewShop({ ...newShop, address: e.target.value })} style={{ marginBottom: 10 }} />
                  <input className="field" placeholder="Google Maps link (optional)" value={newShop.mapsUrl} onChange={(e) => setNewShop({ ...newShop, mapsUrl: e.target.value })} />
                  <div className="k" style={{ margin: "12px 0 8px" }}>Your vinyl colour</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {VINYL_COLORS.map((c) => (
                      <div key={c.id} role="button" onClick={() => setNewShop({ ...newShop, vinylColor: c.hex })}
                        style={{ width: 30, height: 30, borderRadius: "50%", background: "#1C1C1C", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", outline: newShop.vinylColor === c.hex ? "2px solid var(--rust)" : "0.5px solid var(--line)", outlineOffset: 2 }}>
                        <span style={{ width: 12, height: 12, borderRadius: "50%", background: c.hex }} />
                      </div>
                    ))}
                  </div>
                  <div className="k" style={{ fontSize: 11, marginTop: 6 }}>Tip: search your shop on Google Maps → Share → Copy link, and paste it here for an exact pin.</div>
                </div>
              )}
            </>
          )}

          {err && <div style={{ color: "#E06B6B", fontSize: 13, marginTop: 14 }}>{err}</div>}

          <button className="btn-rust" style={{ marginTop: 20, opacity: busy ? 0.6 : 1 }} onClick={submit}>
            {busy ? "Please wait…" : isLogin ? "Log in" : "Create account"}
          </button>
        </div>
      </div>
    </div>
  );
}


// ---- add / edit sub-screens ----
function AddRecord({ releases, listings, shopId, onSave, onCancel }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState(false);
  const [sel, setSel] = useState(null); // a Discogs result
  const [manual, setManual] = useState(false);
  const [nr, setNr] = useState({ artist: "", title: "", year: "", genre: "" });
  const [cond, setCond] = useState("NM");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(1);
  const [image, setImage] = useState(null);
  const [dpct, setDpct] = useState("");
  const [doffer, setDoffer] = useState("");
  const [preview, setPreview] = useState("");

  useEffect(() => {
    if (manual || sel) return;
    const query = q.trim();
    if (query.length < 2) { setResults([]); setSearchErr(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const { data, error } = await supabase.functions.invoke("discogs-search", { body: { q: query } });
        if (cancelled) return;
        if (error) { setResults([]); setSearchErr(true); }
        else { setResults((data && data.results) || []); setSearchErr(false); }
      } catch { if (!cancelled) { setResults([]); setSearchErr(true); } }
      finally { if (!cancelled) setSearching(false); }
    }, 450);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, manual, sel]);

  const pickImage = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) { try { setImage(await fileToScaledDataURL(file)); } catch { /* ignore */ } }
  };

  const canSave = (sel || (manual && nr.artist && nr.title)) && price !== "" && Number(price) >= 0;

  return (
    <div style={{ padding: "4px 18px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0 14px" }}>
        <span onClick={onCancel} role="button" style={{ fontSize: 14, color: "var(--muted)", cursor: "pointer" }}>Cancel</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Add record</span>
        <span style={{ width: 44 }} />
      </div>

      {!manual && !sel && (
        <>
          <div className="k" style={{ marginBottom: 6 }}>Find on Discogs</div>
          <input className="field" placeholder="Artist or title" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          {searching && <div className="k" style={{ marginTop: 10 }}>Searching Discogs…</div>}
          {searchErr && <div className="k" style={{ marginTop: 10, color: "#E0955F" }}>Couldn't reach Discogs. Try again, or add it by hand below.</div>}
          {results.map((r) => (
            <div key={r.discogsId} onClick={() => setSel(r)} className="row card" style={{ padding: "9px 11px", marginTop: 8, cursor: "pointer" }}>
              {r.cover
                ? <img src={r.cover} alt="" style={{ width: 38, height: 38, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
                : <div style={{ width: 38, height: 38, borderRadius: 4, background: "var(--card)", flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                <div className="k">{joinDot([r.artist, r.year, r.genre])}</div>
              </div>
            </div>
          ))}
          <div onClick={() => { setManual(true); setSel(null); setResults([]); }} role="button"
            style={{ fontSize: 13, color: "var(--rust)", cursor: "pointer", marginTop: 12 }}>
            Can't find it? Add it by hand
          </div>
        </>
      )}

      {!manual && sel && (
        <>
          <div className="k" style={{ marginBottom: 6 }}>Record</div>
          <div className="row card" style={{ padding: "10px 12px" }}>
            {sel.cover
              ? <img src={sel.cover} alt="" style={{ width: 46, height: 46, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
              : <div style={{ width: 46, height: 46, borderRadius: 4, background: "var(--card)", flexShrink: 0 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{sel.title}</div>
              <div className="k">{joinDot([sel.artist, sel.year, sel.genre])}</div>
            </div>
            <span role="button" onClick={() => { setSel(null); setQ(""); }} className="k" style={{ cursor: "pointer", color: "var(--rust)" }}>Change</span>
          </div>
        </>
      )}

      {manual && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span className="k">New release</span>
            <span onClick={() => { setManual(false); setNr({ artist: "", title: "", year: "", genre: "" }); }} role="button" style={{ fontSize: 12, color: "var(--rust)", cursor: "pointer" }}>Search Discogs instead</span>
          </div>
          <input className="field" placeholder="Artist" value={nr.artist} onChange={(e) => setNr({ ...nr, artist: e.target.value })} style={{ marginBottom: 8 }} />
          <input className="field" placeholder="Title" value={nr.title} onChange={(e) => setNr({ ...nr, title: e.target.value })} style={{ marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="field" placeholder="Year" value={nr.year} onChange={(e) => setNr({ ...nr, year: e.target.value.replace(/\D/g, "") })} />
            <input className="field" placeholder="Genre" value={nr.genre} onChange={(e) => setNr({ ...nr, genre: e.target.value })} />
          </div>
        </>
      )}

      <div className="k" style={{ margin: "18px 0 6px" }}>Photo of the record</div>
      <div className="row" style={{ gap: 12 }}>
        <div style={{ width: 56, height: 56, borderRadius: 8, border: "0.5px solid var(--line)", background: image ? "transparent" : "var(--card)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
          {image ? <img src={image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--faint)", fontSize: 20 }}>◒</span>}
        </div>
        <label className="btn-ghost" style={{ cursor: "pointer" }}>
          {image ? "Replace photo" : "Add photo"}
          <input type="file" accept="image/*" onChange={pickImage} style={{ display: "none" }} />
        </label>
        {image && <span role="button" onClick={() => setImage(null)} className="k" style={{ cursor: "pointer", color: "var(--rust)" }}>Remove</span>}
      </div>

      <div className="k" style={{ margin: "18px 0 6px" }}>Condition</div>
      <div className="seg">
        {CONDITIONS.map((c) => (
          <div key={c} className={"segi" + (cond === c ? " on" : "")} onClick={() => setCond(c)}>{c}</div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>Price</div>
          <div className="field" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="k">€</span>
            <input value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))} placeholder="28"
              style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>Quantity</div>
          <div className="field" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span role="button" onClick={() => setQty(Math.max(1, qty - 1))} style={{ cursor: "pointer", color: "var(--muted)" }}>−</span>
            <span style={{ fontWeight: 600 }}>{qty}</span>
            <span role="button" onClick={() => setQty(qty + 1)} style={{ cursor: "pointer", color: "var(--muted)" }}>+</span>
          </div>
        </div>
      </div>

      <div className="k" style={{ margin: "16px 0 6px" }}>Discount / offer (optional)</div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ width: 120 }}>
          <div className="field" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input value={dpct} onChange={(e) => setDpct(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="0"
              style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
            <span className="k">% off</span>
          </div>
        </div>
        <input className="field" style={{ flex: 1 }} value={doffer} onChange={(e) => setDoffer(e.target.value)} placeholder="Offer label" />
      </div>

      <div className="k" style={{ margin: "16px 0 6px" }}>Preview link (optional)</div>
      <input className="field" value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="YouTube or SoundCloud link" />

      <div className="k" style={{ margin: "16px 0 14px", display: "flex", gap: 6 }}>
        <span>↻</span>
        <span>Everything here is in-store pickup only. You can add a tracklist and more details by editing the record after saving.</span>
      </div>

      <button className="btn-rust" disabled={!canSave} style={{ opacity: canSave ? 1 : 0.5 }}
        onClick={() => onSave({ discogs: !manual ? sel : null, newRelease: manual ? nr : null, condition: cond, price: Number(price), qty, image, preview, discount: (Number(dpct) > 0 || doffer.trim()) ? { pct: Number(dpct) || 0, label: doffer.trim() || undefined } : undefined })}>
        Save to stock
      </button>
    </div>
  );
}

function NameEditor({ initial, onSave }) {
  const [nm, setNm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = nm.trim() && nm.trim() !== initial;
  const save = async () => { setBusy(true); await onSave(nm); setBusy(false); };
  return (
    <>
      <div className="k" style={{ marginBottom: 6 }}>Your name</div>
      <input className="field" value={nm} onChange={(e) => setNm(e.target.value)} style={{ marginBottom: 10 }} />
      <button className="btn-rust" onClick={save} disabled={busy || !dirty} style={{ opacity: (busy || !dirty) ? 0.5 : 1, marginBottom: 14 }}>Save name</button>
    </>
  );
}

function ProfileScreen({ user, savedCount, reservedCount, onSaveName, onLogout, onBack, onOpenSaved, onOpenReserved }) {
  return (
    <div className="scroll" style={{ padding: "10px 18px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0 14px" }}>
        <span role="button" onClick={onBack} style={{ fontSize: 22, cursor: "pointer" }}>‹</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Profile</span>
        <span style={{ width: 22 }} />
      </div>
      <div className="card" style={{ padding: "12px 14px", marginBottom: 14 }}>
        <div className="k">Signed in as</div>
        <div className="k" style={{ marginTop: 2 }}>{user.email}</div>
      </div>
      <NameEditor initial={user.name} onSave={onSaveName} />
      <div style={{ display: "flex", gap: 12, margin: "4px 0 18px" }}>
        <div className="card" role="button" style={{ flex: 1, padding: "14px", textAlign: "center", cursor: "pointer" }} onClick={onOpenSaved}>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{savedCount}</div>
          <div className="k" style={{ marginTop: 2 }}>Saved</div>
        </div>
        <div className="card" role="button" style={{ flex: 1, padding: "14px", textAlign: "center", cursor: "pointer" }} onClick={onOpenReserved}>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{reservedCount}</div>
          <div className="k" style={{ marginTop: 2 }}>Reserved</div>
        </div>
      </div>
      <button className="btn-ghost" style={{ width: "100%" }} onClick={onLogout}>Log out</button>
    </div>
  );
}

function EditRecord({ listing, release, onSave, onDelete, onCancel, onSetImage, onSetTracklist, onSetPreview, onSetGenre }) {
  const [cond, setCond] = useState(listing.condition);
  const [genre, setGenre] = useState(release.genre || "");
  const [price, setPrice] = useState(String(listing.price));
  const [qty, setQty] = useState(listing.qty);
  const [pct, setPct] = useState(listing.discount && listing.discount.pct ? String(listing.discount.pct) : "");
  const [offer, setOffer] = useState((listing.discount && listing.discount.label) || "");
  const [preview, setPreview] = useState(release.youtubeUrl || "");
  const [sides, setSides] = useState(() =>
    release.tracklist && release.tracklist.length
      ? release.tracklist.map((s) => ({ label: s.label, tracks: [...s.tracks] }))
      : [{ label: "A", tracks: [""] }, { label: "B", tracks: [""] }]
  );

  const setTrack = (si, ti, v) => setSides(sides.map((s, i) => (i === si ? { ...s, tracks: s.tracks.map((t, j) => (j === ti ? v : t)) } : s)));
  const addTrack = (si) => setSides(sides.map((s, i) => (i === si ? { ...s, tracks: [...s.tracks, ""] } : s)));
  const removeTrack = (si, ti) => setSides(sides.map((s, i) => (i === si ? { ...s, tracks: s.tracks.filter((_, j) => j !== ti) } : s)));
  const addSide = () => setSides([...sides, { label: String.fromCharCode(65 + sides.length), tracks: [""] }]);
  const removeSide = (si) => setSides(sides.filter((_, i) => i !== si));

  const pickImage = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) { try { onSetImage(release.id, await fileToScaledDataURL(file)); } catch { /* ignore */ } }
  };

  return (
    <div style={{ padding: "4px 18px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0 14px" }}>
        <span onClick={onCancel} role="button" style={{ fontSize: 14, color: "var(--muted)", cursor: "pointer" }}>Cancel</span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Edit record</span>
        <span style={{ width: 44 }} />
      </div>

      <div className="row card" style={{ padding: "10px 12px" }}>
        <Sleeve release={release} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{release.title}</div>
          <div className="k">{release.artist} · {release.year}</div>
        </div>
        <SourceBadge source={listing.source} />
      </div>

      <div className="k" style={{ margin: "18px 0 6px" }}>Genre</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="field" value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="e.g. Techno, Schranz, Jazz" style={{ flex: 1 }} />
        <button className="btn-ghost" style={{ padding: "0 14px", fontSize: 13, opacity: genre.trim() === (release.genre || "") ? 0.5 : 1 }}
          disabled={genre.trim() === (release.genre || "")}
          onClick={() => onSetGenre(release.id, genre.trim())}>Save</button>
      </div>
      <div className="k" style={{ fontSize: 11, marginTop: 5 }}>Sets how this record is browsed. Shared across shops that stock it.</div>

      <div className="k" style={{ margin: "18px 0 6px" }}>Photo of the record</div>
      <div className="row" style={{ gap: 12 }}>
        <div style={{ width: 56, height: 56, borderRadius: 8, border: "0.5px solid var(--line)", overflow: "hidden", flexShrink: 0, background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {release.image ? <img src={release.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--faint)", fontSize: 20 }}>◒</span>}
        </div>
        <label className="btn-ghost" style={{ cursor: "pointer" }}>
          {release.image ? "Replace photo" : "Add photo"}
          <input type="file" accept="image/*" onChange={pickImage} style={{ display: "none" }} />
        </label>
        {release.image && <span role="button" onClick={() => onSetImage(release.id, null)} className="k" style={{ cursor: "pointer", color: "var(--rust)" }}>Remove</span>}
      </div>

      <div className="k" style={{ margin: "18px 0 6px" }}>Condition</div>
      <div className="seg">
        {CONDITIONS.map((c) => (
          <div key={c} className={"segi" + (cond === c ? " on" : "")} onClick={() => setCond(c)}>{c}</div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>Price</div>
          <div className="field" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="k">€</span>
            <input value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
              style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>Quantity</div>
          <div className="field" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span role="button" onClick={() => setQty(Math.max(0, qty - 1))} style={{ cursor: "pointer", color: "var(--muted)" }}>−</span>
            <span style={{ fontWeight: 600 }}>{qty}</span>
            <span role="button" onClick={() => setQty(qty + 1)} style={{ cursor: "pointer", color: "var(--muted)" }}>+</span>
          </div>
        </div>
      </div>

      <div className="k" style={{ margin: "18px 0 6px", display: "flex", justifyContent: "space-between" }}>
        <span>Discount / offer</span>
        {(pct || offer) ? <span role="button" onClick={() => { setPct(""); setOffer(""); }} style={{ color: "var(--rust)", cursor: "pointer" }}>Remove</span> : null}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ width: 120 }}>
          <div className="field" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input value={pct} onChange={(e) => setPct(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="0"
              style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
            <span className="k">% off</span>
          </div>
        </div>
        <input className="field" style={{ flex: 1 }} value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="Offer label (optional)" />
      </div>
      {Number(pct) > 0 && (
        <div className="k" style={{ fontSize: 12, marginTop: 6 }}>Buyers pay €{Math.round((Number(price) || 0) * (1 - Number(pct) / 100))} instead of €{Number(price) || 0}</div>
      )}

      <div className="k" style={{ margin: "18px 0 6px" }}>Preview link</div>
      <input className="field" value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="YouTube or SoundCloud link" />

      <div className="k" style={{ margin: "18px 0 8px" }}>Tracklist</div>
      {sides.map((side, si) => (
        <div key={si} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Side {side.label}</span>
            {sides.length > 1 ? <span role="button" onClick={() => removeSide(si)} className="k" style={{ color: "var(--rust)", cursor: "pointer" }}>Remove side</span> : null}
          </div>
          {side.tracks.map((t, ti) => (
            <div key={ti} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="k" style={{ width: 14, flexShrink: 0 }}>{ti + 1}</span>
              <input className="field" style={{ flex: 1 }} value={t} onChange={(e) => setTrack(si, ti, e.target.value)} placeholder="Song title" />
              {side.tracks.length > 1 ? <span role="button" onClick={() => removeTrack(si, ti)} style={{ cursor: "pointer", color: "var(--faint)", fontSize: 18, width: 16, textAlign: "center" }}>×</span> : null}
            </div>
          ))}
          <span role="button" onClick={() => addTrack(si)} style={{ fontSize: 13, color: "var(--rust)", cursor: "pointer" }}>+ Add song</span>
        </div>
      ))}
      <span role="button" onClick={addSide} className="btn-ghost" style={{ display: "inline-block", cursor: "pointer" }}>+ Add side</span>

      <button className="btn-rust" style={{ marginTop: 20 }}
        onClick={() => { onSetTracklist(release.id, sides); onSetPreview(release.id, preview); onSave({ ...listing, condition: cond, price: Number(price) || 0, qty, discount: (Number(pct) > 0 || offer.trim()) ? { pct: Number(pct) || 0, label: offer.trim() || undefined } : undefined, updated: new Date().toISOString() }); }}>
        Save changes
      </button>
      <button className="btn-ghost" style={{ width: "100%", marginTop: 10, color: "#E06B6B", borderColor: "#402626" }}
        onClick={() => onDelete(listing.id)}>
        Remove from stock
      </button>
    </div>
  );
}

// ---- root ----
function EmptyState({ text, actionLabel, onAction }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--muted)" }}>
      <Disc size={44} />
      <div style={{ fontSize: 14, margin: "14px 0 18px", lineHeight: 1.5 }}>{text}</div>
      {actionLabel ? (
        <button className="btn-rust" style={{ width: "auto", padding: "9px 18px" }} onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}

function Thread({ title, subtitle, messages, meSender, onSend, onBack, onRefresh, onSeen }) {
  const [draft, setDraft] = useState("");
  useEffect(() => { if (onSeen) onSeen(); /* mark seen on open + when new msgs load */ }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = () => { const t = draft.trim(); if (!t) return; setDraft(""); onSend(t); };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "8px 16px 10px", display: "flex", alignItems: "center", gap: 10, borderBottom: "0.5px solid var(--line)" }}>
        <span role="button" onClick={onBack} style={{ fontSize: 22, cursor: "pointer" }}>‹</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
          {subtitle ? <div className="k" style={{ fontSize: 11 }}>{subtitle}</div> : null}
        </div>
        <span role="button" onClick={onRefresh} className="k" style={{ cursor: "pointer", fontSize: 18 }} title="Refresh">↻</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 ? (
          <div className="k" style={{ textAlign: "center", padding: "30px 10px" }}>No messages yet. Start the conversation.</div>
        ) : messages.map((m) => {
          const mine = m.sender === meSender;
          return (
            <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "80%" }}>
              <div style={{ background: mine ? "var(--rust)" : "var(--card)", color: mine ? "var(--cream)" : "var(--ink)", padding: "8px 12px", borderRadius: 14, fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
              <div className="k" style={{ fontSize: 10, marginTop: 2, textAlign: mine ? "right" : "left" }}>{mine ? "You" : (m.senderName || (m.sender === "owner" ? "Shop" : "Buyer"))}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderTop: "0.5px solid var(--line)" }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} placeholder="Message…" className="field" style={{ flex: 1 }} />
        <button className="btn-rust" style={{ width: "auto", padding: "9px 16px" }} onClick={send}>Send</button>
      </div>
    </div>
  );
}

function ShopEditor({ shop, onSave }) {
  const [name, setName] = useState(shop ? shop.name : "");
  const [hood, setHood] = useState(shop ? shop.hood || "" : "");
  const [address, setAddress] = useState(shop ? shop.address || "" : "");
  const [mapsUrl, setMapsUrl] = useState(shop ? shop.mapsUrl || "" : "");
  const [vinylColor, setVinylColor] = useState(shop && shop.vinylColor ? shop.vinylColor : "#E0673C");
  const initHold = shop && typeof shop.holdHours === "number" ? shop.holdHours : 48;
  const [holdDays, setHoldDays] = useState(Math.floor(initHold / 24));
  const [holdHrs, setHoldHrs] = useState(initHold % 24);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const totalHold = holdDays * 24 + holdHrs;
  const holdLabel = joinDot([holdDays > 0 ? `${holdDays} day${holdDays === 1 ? "" : "s"}` : null, holdHrs > 0 ? `${holdHrs} hour${holdHrs === 1 ? "" : "s"}` : null]) || "0 hours";
  const save = async () => {
    if (busy) return;
    setErr(null); setBusy(true);
    const e = await onSave({ name, hood, address, mapsUrl, holdHours: totalHold > 0 ? totalHold : 48, vinylColor });
    setBusy(false);
    if (e) setErr(e);
  };
  const selStyle = { flex: 1, fontSize: 14, background: "var(--card)", color: "var(--ink)", border: "0.5px solid var(--line)", borderRadius: 10, padding: "10px 12px" };
  return (
    <div className="card" style={{ padding: "12px 14px", marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Your shop</div>
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shop name" style={{ marginBottom: 8 }} />
      <input className="field" value={hood} onChange={(e) => setHood(e.target.value)} placeholder="Neighborhood" style={{ marginBottom: 8 }} />
      <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address" style={{ marginBottom: 8 }} />
      <input className="field" value={mapsUrl} onChange={(e) => setMapsUrl(e.target.value)} placeholder="Google Maps link (optional)" />

      <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600 }}>Reserve hold</div>
      <div className="k" style={{ marginTop: 2, marginBottom: 8, lineHeight: 1.4 }}>How long a reserved record is held before it goes back on the shelf.</div>
      <div style={{ display: "flex", gap: 8 }}>
        <select value={holdDays} onChange={(e) => setHoldDays(Number(e.target.value))} style={selStyle} aria-label="Days">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n} day{n === 1 ? "" : "s"}</option>)}
        </select>
        <select value={holdHrs} onChange={(e) => setHoldHrs(Number(e.target.value))} style={selStyle} aria-label="Hours">
          {[0, 1, 2, 3, 4, 6, 8, 12, 18].map((n) => <option key={n} value={n}>{n} hour{n === 1 ? "" : "s"}</option>)}
        </select>
      </div>
      <div className="k" style={{ marginTop: 8 }}>Held for {holdLabel}, then released automatically.</div>

      <div style={{ marginTop: 14, fontSize: 13, fontWeight: 600 }}>Your vinyl colour</div>
      <div className="k" style={{ marginTop: 2, marginBottom: 8 }}>Shown on your shop's spinning record.</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {VINYL_COLORS.map((c) => (
          <div key={c.id} role="button" onClick={() => setVinylColor(c.hex)}
            style={{ width: 30, height: 30, borderRadius: "50%", background: "#1C1C1C", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", outline: vinylColor === c.hex ? "2px solid var(--rust)" : "0.5px solid var(--line)", outlineOffset: 2 }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: c.hex }} />
          </div>
        ))}
      </div>

      {err && <div style={{ color: "#E06B6B", fontSize: 13, marginTop: 10 }}>{err}</div>}
      <button className="btn-rust" style={{ marginTop: 12, opacity: busy ? 0.6 : 1 }} onClick={save}>{busy ? "Saving…" : "Save shop details"}</button>
    </div>
  );
}

function BuyerCatalog({ seed, savedDiscogsIds, onSave, onBack }) {
  const [q, setQ] = useState(seed || "");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState(false);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults([]); setErr(false); setSearching(false); return; }
    let cancelled = false; setSearching(true);
    const t = setTimeout(async () => {
      try {
        const { data, error } = await supabase.functions.invoke("discogs-search", { body: { q: query } });
        if (cancelled) return;
        if (error) { setResults([]); setErr(true); }
        else { setResults((data && data.results) || []); setErr(false); }
      } catch { if (!cancelled) { setResults([]); setErr(true); } }
      finally { if (!cancelled) setSearching(false); }
    }, 450);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);
  return (
    <div style={{ padding: "6px 18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span role="button" onClick={onBack} style={{ fontSize: 22, cursor: "pointer" }}>‹</span>
        <span style={{ fontSize: 18, fontWeight: 600 }}>Full catalog</span>
      </div>
      <div className="k" style={{ marginBottom: 12, lineHeight: 1.45 }}>Search every record on Discogs and add it to your hunting list — you'll see it here when a Berlin shop has it.</div>
      <div className="row card" style={{ padding: "10px 12px", marginBottom: 14 }}>
        <span style={{ color: "var(--muted)" }}>⌕</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search artist or title" autoFocus
          style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
      </div>
      {searching && <div className="k" style={{ textAlign: "center", padding: "20px" }}>Searching Discogs…</div>}
      {err && <div className="k" style={{ textAlign: "center", padding: "20px", color: "#E06B6B" }}>Catalog search is unavailable right now.</div>}
      {!searching && !err && q.trim().length >= 2 && results.length === 0 && (
        <div className="k" style={{ textAlign: "center", padding: "20px" }}>No matches on Discogs.</div>
      )}
      {results.map((res) => {
        const isSaved = res.discogsId && savedDiscogsIds.has(res.discogsId);
        return (
          <div key={res.discogsId || (res.artist + res.title)} className="row card" style={{ padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ width: 46, height: 46, borderRadius: 6, overflow: "hidden", flexShrink: 0, background: "var(--card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {res.cover ? <img src={res.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--faint)" }}>◒</span>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{res.title}</div>
              <div className="k">{joinDot([res.artist, res.year, res.genre])}</div>
            </div>
            <button disabled={isSaved} onClick={() => onSave(res)} className={isSaved ? "btn-ghost" : "btn-rust"}
              style={{ width: "auto", padding: "7px 12px", fontSize: 13, opacity: isSaved ? 0.6 : 1, flexShrink: 0 }}>{isSaved ? "Saved" : "♡ Save"}</button>
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState({ shops: [], releases: [] });
  const [listings, setListings] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [messages, setMessages] = useState([]);
  const [wants, setWants] = useState([]);

  const [currentUser, setCurrentUser] = useState(null);
  const [authTab, setAuthTab] = useState("login");
  const [showAuth, setShowAuth] = useState(false);
  const [authReason, setAuthReason] = useState(null);
  const [authInitialRole, setAuthInitialRole] = useState("buyer");
  const [pendingAction, setPendingAction] = useState(null);
  const [recentEmails, setRecentEmails] = useState([]);
  const [msgSeen, setMsgSeen] = useState({});
  const [hideGenreNote, setHideGenreNote] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [bScreen, setBScreen] = useState({ name: "stores" });
  const [oScreen, setOScreen] = useState({ name: "stock" });
  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState(null); // null | {type,value,label}
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [shopQuery, setShopQuery] = useState("");
  const [shopGenre, setShopGenre] = useState("all");
  const [shopSort, setShopSort] = useState("recent");
  const [stockFilter, setStockFilter] = useState("all");
  const [stockDate, setStockDate] = useState("all");
  const [stockQuery, setStockQuery] = useState("");
  const [toast, setToast] = useState(null);

  const shopById = useMemo(() => Object.fromEntries(catalog.shops.map((s) => [s.id, s])), [catalog.shops]);
  const relById = useMemo(() => Object.fromEntries(catalog.releases.map((r) => [r.id, r])), [catalog.releases]);

  // ---- Supabase loaders ----
  const loadCatalog = async () => {
    const [shopsRes, relRes] = await Promise.all([
      supabase.from("shops").select("*"),
      supabase.from("releases").select("*"),
    ]);
    if (shopsRes.error) console.error("shops load:", shopsRes.error.message);
    if (relRes.error) console.error("releases load:", relRes.error.message);
    setCatalog({ shops: (shopsRes.data || []).map(mapShop), releases: (relRes.data || []).map(mapRelease) });
  };
  const loadListings = async () => {
    const { data, error } = await supabase.from("listings").select("*");
    if (error) console.error("listings load:", error.message);
    setListings((data || []).map(mapListing));
  };
  const loadReservations = async () => {
    const { data, error } = await supabase.from("reservations").select("*");
    if (error) console.error("reservations load:", error.message);
    setReservations((data || []).map(mapReservation));
  };
  const loadMessages = async () => {
    const { data, error } = await supabase.from("messages").select("*");
    if (error) console.error("messages load:", error.message);
    setMessages((data || []).map(mapMessage));
  };
  const loadWants = async () => {
    const { data, error } = await supabase.from("wants").select("*");
    if (error) { console.error("wants load:", error.message); return; }
    setWants((data || []).map((w) => ({ id: w.id, buyerId: w.buyer_id, releaseId: w.release_id, created: w.created_at })));
  };
  const loadAll = async () => {
    try { await supabase.rpc("expire_stale_reservations"); } catch (e) { /* ignore */ }
    await Promise.all([loadCatalog(), loadListings(), loadReservations(), loadMessages(), loadWants()]);
  };

  const loadProfile = async (userId, email) => {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) console.error("profile load:", error.message);
    if (data) setCurrentUser({ id: data.id, name: data.name, role: data.role, shopId: data.shop_id, saved: data.saved || [], email });
    else setCurrentUser(null);
    return data;
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session && session.user) await loadProfile(session.user.id, session.user.email);
      await loadAll();
      setRecentEmails(getRecentEmails());
      setMsgSeen(getMsgSeen());
      try { if (localStorage.getItem("cd:hide_genre_note") === "1") setHideGenreNote(true); } catch { /* ignore */ }
      if (mounted) setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session && session.user) { await loadProfile(session.user.id, session.user.email); await loadAll(); }
      else { setCurrentUser(null); }
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 1800); };

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const openAuth = (tab = "login", role = "buyer", reason = null) => {
    setAuthTab(tab); setAuthInitialRole(role); setAuthReason(reason); setShowAuth(true);
  };
  // Guests can browse freely; actions that need an account funnel through here.
  const requireAuth = (reason, action) => {
    if (currentUser) { if (action) action(); return; }
    setPendingAction(action ? { run: action } : null);
    openAuth("register", "buyer", reason || null);
  };
  // After a guest signs in, resume whatever they were trying to do.
  useEffect(() => {
    if (currentUser && pendingAction) {
      const p = pendingAction;
      setPendingAction(null); setShowAuth(false); setAuthReason(null);
      setTimeout(() => { try { p.run(); } catch { /* ignore */ } }, 80);
    } else if (currentUser && showAuth) {
      setShowAuth(false); setAuthReason(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const rememberEmail = (email) => {
    const em = (email || "").trim().toLowerCase();
    if (!em) return;
    const next = [em, ...recentEmails.filter((e) => e !== em)].slice(0, 5);
    setRecentEmails(next);
    putRecentEmails(next);
  };

  // ---- auth ----
  const login = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email: (email || "").trim(), password });
    if (error) return /invalid/i.test(error.message) ? "Wrong email or password." : error.message;
    rememberEmail(email);
    setBScreen({ name: "stores" }); setOScreen({ name: "stock" });
    return null; // profile + data load via onAuthStateChange
  };

  const register = async ({ name, email, password, role, newShop }) => {
    const em = (email || "").trim();
    if (!name.trim() || !em || !password) return "Fill in your name, email, and password.";
    if (password.length < 6) return "Password must be at least 6 characters.";
    if (role === "owner") {
      if (!(newShop && newShop.name.trim())) return "Enter your shop name.";
      if (!newShop.address || !newShop.address.trim()) return "Enter your shop address.";
    }
    const { data, error } = await supabase.auth.signUp({ email: em, password });
    if (error) return /registered|exists/i.test(error.message) ? "That email is already registered." : error.message;
    const user = data.user;
    if (!user) return "Could not create the account — check the email confirmation setting in Supabase.";
    let shopId = null;
    if (role === "owner") {
      const { data: shop, error: se } = await supabase.from("shops").insert({
        owner_id: user.id, name: newShop.name.trim(), hood: (newShop.hood || "").trim() || "Berlin",
        address: newShop.address.trim(), maps_url: (newShop.mapsUrl || "").trim() || null,
        vinyl_color: newShop.vinylColor || null,
      }).select().single();
      if (se) return "Account made, but the shop couldn't be created: " + se.message;
      shopId = shop.id;
    }
    const { error: pe } = await supabase.from("profiles").insert({ id: user.id, name: name.trim(), role, shop_id: shopId, saved: [] });
    if (pe) return "Account made, but the profile couldn't be saved: " + pe.message;
    rememberEmail(em);
    await loadProfile(user.id, em);
    await loadAll();
    setBScreen({ name: "stores" }); setOScreen({ name: "stock" });
    return null;
  };

  const updateShop = async ({ name, hood, address, mapsUrl, holdHours, vinylColor }) => {
    if (!currentUser || !currentUser.shopId) return "No shop linked to your account.";
    if (!name.trim()) return "Shop name can't be empty.";
    if (!address.trim()) return "Address can't be empty.";
    const patch = { name: name.trim(), hood: hood.trim() || "Berlin", address: address.trim(), maps_url: mapsUrl.trim() || null };
    if (typeof holdHours === "number" && holdHours > 0) patch.hold_hours = holdHours;
    if (vinylColor) patch.vinyl_color = vinylColor;
    const { error } = await supabase.from("shops").update(patch).eq("id", currentUser.shopId);
    if (error) return error.message;
    await loadCatalog();
    flash("Shop updated");
    return null;
  };

  const updateName = async (name) => {
    const n = (name || "").trim();
    if (!n) { flash("Name can't be empty."); return; }
    const { error } = await supabase.from("profiles").update({ name: n }).eq("id", currentUser.id);
    if (error) { flash("Couldn't update name"); console.error(error.message); return; }
    setCurrentUser({ ...currentUser, name: n });
    flash("Name updated");
  };

  const logout = async () => { await supabase.auth.signOut(); setCurrentUser(null); setBScreen({ name: "stores" }); };

  // ---- buyer actions ----
  const toggleSave = async (releaseId) => {
    if (!currentUser) return;
    const has = wants.some((w) => w.buyerId === currentUser.id && w.releaseId === releaseId);
    if (has) {
      setWants(wants.filter((w) => !(w.buyerId === currentUser.id && w.releaseId === releaseId)));
      const { error } = await supabase.from("wants").delete().eq("buyer_id", currentUser.id).eq("release_id", releaseId);
      if (error) { console.error("unsave:", error.message); await loadWants(); }
    } else {
      const { error } = await supabase.from("wants").insert({ buyer_id: currentUser.id, release_id: releaseId });
      if (error) { flash("Couldn't save"); console.error("save:", error.message); }
      await loadWants();
    }
  };

  // Save a Discogs catalog result to the want-list, even if no shop stocks it yet.
  const saveCatalogRecord = async (res) => {
    if (!currentUser) return;
    let releaseId = null;
    if (res.discogsId) {
      const { data: existing } = await supabase.from("releases").select("id").eq("discogs_release_id", res.discogsId).maybeSingle();
      if (existing) releaseId = existing.id;
    }
    if (!releaseId) {
      const { data: ins, error } = await supabase.from("releases").insert({
        artist: res.artist || "Unknown", title: res.title || "Untitled",
        year: res.year || null, genre: res.genre || null, format: res.format || "LP",
        image: res.cover || null, discogs_release_id: res.discogsId || null,
      }).select("id").single();
      if (error) { flash("Couldn't add that record"); console.error("catalog insert:", error.message); return; }
      releaseId = ins.id;
    }
    const { error: we } = await supabase.from("wants").insert({ buyer_id: currentUser.id, release_id: releaseId });
    if (we && !/duplicate|unique/i.test(we.message)) { flash("Couldn't save"); console.error("catalog want:", we.message); }
    await Promise.all([loadCatalog(), loadWants()]);
    flash("Added to your hunting list");
  };

  // Owner taps to message every buyer who wants a record the shop now stocks.
  const notifyWanters = async (releaseId) => {
    if (!myShopId) return;
    const r = relById[releaseId];
    const buyerIds = wants.filter((w) => w.releaseId === releaseId).map((w) => w.buyerId);
    if (buyerIds.length === 0) return;
    const shopName = (myShop && myShop.name) || "the shop";
    const body = `Good news — ${r ? r.title : "a record"}${r && r.artist ? " by " + r.artist : ""} is in stock now at ${shopName}. Reserve it and pick it up in store.`;
    const rows = buyerIds.map((bid) => ({ shop_id: myShopId, buyer_id: bid, sender: "owner", sender_name: shopName, body }));
    const { error } = await supabase.from("messages").insert(rows);
    if (error) { flash("Couldn't notify"); console.error("notify:", error.message); return; }
    await loadMessages();
    flash(`Notified ${buyerIds.length} buyer${buyerIds.length === 1 ? "" : "s"}`);
  };

  const reserve = async (l) => {
    const { error } = await supabase.rpc("request_reservation", { p_listing: l.id });
    if (error) { flash(/spoken/i.test(error.message) ? "Just got reserved by someone else" : "Couldn't reserve"); await loadListings(); return; }
    await Promise.all([loadListings(), loadReservations()]);
    flash("Request sent — waiting for the shop");
  };

  // ---- owner actions ----
  const setListingStatus = async (id, status) => {
    const { error } = await supabase.from("listings").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) { flash("Couldn't update"); console.error(error.message); }
    await loadListings();
  };

  const saveEdit = async (u) => {
    const { error } = await supabase.from("listings").update({
      condition: u.condition, price: u.price, qty: u.qty, discount: u.discount || null, updated_at: new Date().toISOString(),
    }).eq("id", u.id);
    if (error) { flash("Couldn't save"); console.error(error.message); return; }
    await loadListings(); setOScreen({ name: "stock" }); flash("Changes saved");
  };

  const deleteListing = async (id) => {
    const { error } = await supabase.from("listings").delete().eq("id", id);
    if (error) { flash("Couldn't remove"); console.error(error.message); return; }
    await loadListings(); setOScreen({ name: "stock" }); flash("Removed");
  };

  const setReleaseImage = async (releaseId, dataUrl) => {
    const { error } = await supabase.from("releases").update({ image: dataUrl || null }).eq("id", releaseId);
    if (error) console.error("image save:", error.message);
    await loadCatalog();
  };

  const setReleaseTracklist = async (releaseId, sides) => {
    const clean = sides
      .map((s) => ({ label: s.label, tracks: s.tracks.map((t) => t.trim()).filter(Boolean) }))
      .filter((s) => s.tracks.length);
    const { error } = await supabase.from("releases").update({ tracklist: clean.length ? clean : null }).eq("id", releaseId);
    if (error) console.error("tracklist save:", error.message);
    await loadCatalog();
  };

  const setReleasePreview = async (releaseId, url) => {
    const { error } = await supabase.from("releases").update({ youtube_url: (url || "").trim() || null }).eq("id", releaseId);
    if (error) console.error("preview save:", error.message);
    await loadCatalog();
  };

  const setReleaseGenre = async (releaseId, genre) => {
    const { error } = await supabase.from("releases").update({ genre: (genre || "").trim() || null }).eq("id", releaseId);
    if (error) { flash("Couldn't update genre"); console.error("genre save:", error.message); return; }
    await loadCatalog();
    flash("Genre updated");
  };

  const addRecord = async ({ discogs, release, newRelease, condition, price, qty, image, discount, preview }) => {
    if (!currentUser || !currentUser.shopId) { flash("No shop linked to your account"); return; }
    const palette = [["#2C3A2E", "#D8763A"], ["#33283F", "#6FA5A0"], ["#3B2C22", "#E09A3C"], ["#20242E", "#5DCAA5"]];
    let releaseId;
    if (discogs && discogs.discogsId) {
      // reuse an existing release with the same Discogs id (same record, any spelling)
      const { data: existing } = await supabase.from("releases").select("id").eq("discogs_release_id", discogs.discogsId).limit(1).maybeSingle();
      if (existing && existing.id) {
        releaseId = existing.id;
        const patch = {};
        if (image) patch.image = image;                       // owner photo overrides
        if (preview && preview.trim()) patch.youtube_url = preview.trim();
        if (Object.keys(patch).length) await supabase.from("releases").update(patch).eq("id", releaseId);
      } else {
        const { data: rel, error } = await supabase.from("releases").insert({
          artist: discogs.artist || "", title: discogs.title || "", year: discogs.year || null,
          genre: discogs.genre || "", format: discogs.format || "LP",
          cover: palette[Math.floor(Math.random() * palette.length)],
          image: image || discogs.cover || null,             // owner photo, else Discogs cover
          discogs_release_id: discogs.discogsId,
          youtube_url: (preview || "").trim() || null,
        }).select().single();
        if (error) { flash("Couldn't add the record"); console.error(error.message); return; }
        releaseId = rel.id;
      }
    } else if (newRelease) {
      const { data: rel, error } = await supabase.from("releases").insert({
        artist: newRelease.artist, title: newRelease.title, year: Number(newRelease.year) || null,
        genre: newRelease.genre || "", format: "LP", cover: palette[Math.floor(Math.random() * palette.length)],
        image: image || null, youtube_url: (preview || "").trim() || null,
      }).select().single();
      if (error) { flash("Couldn't add the record"); console.error(error.message); return; }
      releaseId = rel.id;
    } else if (release) {
      releaseId = release.id;
      const patch = {};
      if (image) patch.image = image;
      if (preview && preview.trim()) patch.youtube_url = preview.trim();
      if (Object.keys(patch).length) await supabase.from("releases").update(patch).eq("id", releaseId);
    } else {
      flash("Pick a record first"); return;
    }
    const { error: le } = await supabase.from("listings").insert({
      shop_id: currentUser.shopId, release_id: releaseId, condition, price, qty,
      discount: discount || null, status: "available", source: "manual",
    });
    if (le) { flash("Couldn't add to stock"); console.error(le.message); return; }
    await Promise.all([loadCatalog(), loadListings()]);
    setOScreen({ name: "stock" }); flash("Added to stock");
  };

  const importCSV = async (file) => {
    if (!currentUser || !currentUser.shopId) { flash("No shop linked to your account"); return; }
    let text;
    try { text = await file.text(); } catch { flash("Couldn't read that file"); return; }
    const rows = parseCSV(text);
    if (!rows.length) { flash("No rows found — need artist, title, price"); return; }
    const seen = {}; // "artist|title" -> releaseId, to dedupe within the file
    catalog.releases.forEach((r) => { seen[(r.artist + "|" + r.title).toLowerCase()] = r.id; });
    const palette = [["#2C3A2E", "#D8763A"], ["#33283F", "#6FA5A0"], ["#3B2C22", "#E09A3C"], ["#20242E", "#5DCAA5"]];
    let added = 0;
    for (const row of rows) {
      const key = (row.artist + "|" + row.title).toLowerCase();
      let releaseId = seen[key];
      if (!releaseId) {
        const { data, error } = await supabase.from("releases").insert({
          artist: row.artist, title: row.title, format: "LP", cover: palette[Math.floor(Math.random() * palette.length)],
        }).select().single();
        if (error) { console.error("csv release:", error.message); continue; }
        releaseId = data.id; seen[key] = releaseId;
      }
      const { error: le } = await supabase.from("listings").insert({
        shop_id: currentUser.shopId, release_id: releaseId, condition: "NM",
        price: Number(row.price) || 0, qty: 1, status: "available", source: "manual",
      });
      if (le) console.error("csv listing:", le.message); else added++;
    }
    await Promise.all([loadCatalog(), loadListings()]);
    flash(`Imported ${added} record${added === 1 ? "" : "s"}`);
  };

  // ---- reservation approval ----
  const acceptReservation = async (res) => {
    const hrs = (myShop && myShop.holdHours) || 48;
    const holdUntil = new Date(Date.now() + hrs * 3600000).toISOString();
    const { error } = await supabase.from("reservations").update({ status: "held", hold_until: holdUntil }).eq("id", res.id);
    if (error) { flash("Couldn't accept — try again"); console.error("accept:", error.message); return; }
    await supabase.from("listings").update({ status: "reserved", updated_at: new Date().toISOString() }).eq("id", res.listingId);
    await Promise.all([loadListings(), loadReservations()]); flash("Reservation accepted");
  };
  const declineReservation = async (res) => {
    await supabase.from("listings").update({ status: "available", updated_at: new Date().toISOString() }).eq("id", res.listingId);
    await supabase.from("reservations").update({ status: "cancelled" }).eq("id", res.id);
    await Promise.all([loadListings(), loadReservations()]); flash("Request declined");
  };
  const markPickedUp = async (res) => {
    await supabase.from("listings").update({ status: "sold", updated_at: new Date().toISOString() }).eq("id", res.listingId);
    await supabase.from("reservations").update({ status: "picked_up" }).eq("id", res.id);
    await Promise.all([loadListings(), loadReservations()]); flash("Marked picked up");
  };
  const cancelReservation = async (res) => {
    await supabase.from("listings").update({ status: "available", updated_at: new Date().toISOString() }).eq("id", res.listingId);
    await supabase.from("reservations").update({ status: "cancelled" }).eq("id", res.id);
    await Promise.all([loadListings(), loadReservations()]); flash("Reservation released");
  };

  // ---- messaging ----
  const markThreadSeen = (threadKey) => {
    setMsgSeen((prev) => { const next = { ...prev, [threadKey]: new Date().toISOString() }; putMsgSeen(next); return next; });
  };
  const sendMessage = async (shopId, buyerId, sender, body) => {
    const text = (body || "").trim();
    if (!text) return;
    const { error } = await supabase.from("messages").insert({
      shop_id: shopId, buyer_id: buyerId, sender, sender_name: (currentUser && currentUser.name) || null, body: text,
    });
    if (error) { flash("Couldn't send"); console.error("send message:", error.message); return; }
    await loadMessages();
  };

  // ---- derived views ----
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    const score = (r) => {
      if (!q) return 0;
      const artist = r.artist.toLowerCase();
      const title = r.title.toLowerCase();
      const genre = (r.genre || "").toLowerCase();
      if (title.startsWith(q) || artist.startsWith(q)) return 0;         // starts with the query
      if ((artist + " " + title).split(/\s+/).some((w) => w.startsWith(q))) return 1; // a word starts with it
      if (title.includes(q) || artist.includes(q)) return 2;            // appears somewhere
      if (genre.includes(q)) return 3;                                  // genre match
      return -1;                                                        // no match
    };
    return catalog.releases
      .map((r) => {
        const avail = listings.filter((l) => l.releaseId === r.id && l.status === "available");
        return { release: r, shops: avail.length, min: avail.length ? Math.min(...avail.map(effPrice)) : null, s: score(r) };
      })
      .filter((x) => x.shops > 0 && x.s >= 0)
      .sort((a, b) => a.s - b.s || a.release.title.localeCompare(b.release.title));
  }, [query, catalog.releases, listings]);

  const styleTag = (
    <style>{`
      .rille *{box-sizing:border-box}
      .rille{--cream:#0B0B0C;--ink:#F2F2F2;--rust:#E0673C;--card:#151515;--line:#2A2A2A;--muted:#9A9A9A;--faint:#5E5E5E;--panel:#101010;
        font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
      .serif{font-family:Georgia,'Iowan Old Style','Times New Roman',serif}
      .card{background:var(--card);border:0.5px solid var(--line);border-radius:12px}
      .k{font-size:12px;color:var(--muted)}
      .row{display:flex;align-items:center;gap:11px}
      .field{width:100%;background:var(--card);border:0.5px solid var(--line);border-radius:10px;padding:10px 12px;font-size:15px;color:var(--ink);outline:none}
      .field:focus{border-color:var(--rust);box-shadow:0 0 0 2px rgba(224,103,60,.28)}
      input::placeholder{color:var(--faint)}
      .btn-rust{background:var(--rust);color:var(--cream);border:none;border-radius:12px;padding:13px 16px;font-size:15px;font-weight:600;cursor:pointer;width:100%}
      .btn-ghost{background:transparent;border:0.5px solid var(--line);border-radius:10px;padding:11px 14px;font-size:14px;color:var(--ink);cursor:pointer}
      .seg{display:flex;gap:6px}
      .segi{flex:1;text-align:center;font-size:13px;padding:9px 0;border-radius:8px;background:var(--card);border:0.5px solid var(--line);cursor:pointer}
      .segi.on{background:var(--rust);color:var(--cream);border-color:var(--rust);font-weight:600}
      .tab{display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:none;cursor:pointer;font-size:11px;color:var(--faint);padding:0;flex:1}
      .tab.active{color:var(--rust);font-weight:600}
      .tabicon{font-size:19px;line-height:1}
      .spin{animation:spin 22s linear infinite;transform-origin:50% 50%}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes armswing{0%{transform:rotate(-3deg)}100%{transform:rotate(6deg)}}
      .tonearm-play{animation:armswing 20s ease-in-out infinite alternate}
      @keyframes gm_spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
      @keyframes gm_shake{0%,100%{transform:translate(0,0) rotate(0)}25%{transform:translate(-1px,.8px) rotate(-3deg)}50%{transform:translate(1px,-.8px) rotate(3deg)}75%{transform:translate(-.8px,-.8px) rotate(-2deg)}}
      @keyframes gm_shakehard{0%,100%{transform:translate(0,0) rotate(0)}20%{transform:translate(-2px,1.6px) rotate(-6deg)}40%{transform:translate(2px,-1.6px) rotate(6deg)}60%{transform:translate(-1.6px,-1.4px) rotate(-5deg)}80%{transform:translate(1.6px,1.4px) rotate(5deg)}}
      @keyframes gm_jolt{0%,100%{transform:translateX(0)}25%{transform:translateX(-2.5px)}50%{transform:translateX(2.5px)}75%{transform:translateX(-1.5px)}}
      @keyframes gm_jitter{0%{transform:translate(0,0) rotate(0)}15%{transform:translate(2px,-1.5px) rotate(5deg)}30%{transform:translate(-2px,1px) rotate(-6deg)}45%{transform:translate(1.5px,2px) rotate(3deg)}60%{transform:translate(-1.5px,-2px) rotate(-4deg)}75%{transform:translate(2px,1px) rotate(6deg)}90%{transform:translate(-1px,-1px) rotate(-3deg)}100%{transform:translate(0,0) rotate(0)}}
      @keyframes gm_swing{0%,100%{transform:rotate(-7deg) translateY(0)}50%{transform:rotate(7deg) translateY(-2px)}}
      @keyframes gm_sway{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}
      @keyframes gm_wobble{0%,100%{transform:rotate(-10deg) translateY(0)}50%{transform:rotate(10deg) translateY(-1.5px)}}
      @keyframes gm_groove{0%,100%{transform:rotate(-3deg) scale(1)}50%{transform:rotate(3deg) scale(1.03)}}
      @keyframes gm_pulse{0%,100%{transform:scale(1)}50%{transform:scale(.86)}}
      @keyframes gm_afro{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-2px) rotate(4deg)}}
      @keyframes gm_bob{0%,100%{transform:translateY(-2.5px)}50%{transform:translateY(2.5px)}}
      @keyframes gm_bounce{0%,100%{transform:scale(1) translateY(1px)}50%{transform:scale(1.08) translateY(-2px)}}
      @keyframes gm_nod{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-2px) rotate(-5deg)}50%{transform:translateY(0) rotate(0)}75%{transform:translateY(-2px) rotate(5deg)}}
      .gm-spin{}
      .gm-house{animation:gm_swing .9s ease-in-out infinite}
      .gm-prog{animation:gm_jitter .8s steps(3,end) infinite}
      .gm-drift{animation:gm_spin 9s linear infinite}
      .gm-shake{animation:gm_shake .3s linear infinite}
      .gm-shakehard{animation:gm_shakehard .2s linear infinite}
      .gm-jolt{animation:gm_jolt .25s linear infinite}
      .gm-sway{animation:gm_sway 2.6s ease-in-out infinite}
      .gm-wobble{animation:gm_wobble 1.5s ease-in-out infinite}
      .gm-groove{animation:gm_groove 1.6s ease-in-out infinite}
      .gm-pulse{animation:gm_pulse 1.15s ease-in-out infinite}
      .gm-afro{animation:gm_afro 1s ease-in-out infinite}
      .gm-bob{animation:gm_bob .5s ease-in-out infinite}
      .gm-bounce{animation:gm_bounce .7s ease-in-out infinite}
      .gm-nod{animation:gm_nod .9s ease-in-out infinite}
      @media (prefers-reduced-motion:reduce){.spin,.tonearm-play,[class^="gm-"]{animation:none}}
      .modeseg{display:flex;background:var(--panel);border-radius:999px;padding:3px}
      .modeseg button{flex:1;border:none;background:transparent;border-radius:999px;padding:6px 10px;font-size:13px;color:var(--muted);cursor:pointer}
      .modeseg button.on{background:var(--rust);color:var(--cream);font-weight:600}
      .scroll{overflow-y:auto;flex:1;min-height:0;-webkit-overflow-scrolling:touch}
      .scroll::-webkit-scrollbar{width:0}
    `}</style>
  );

  if (loading) {
    return (
      <div className="rille" style={{ minHeight: "100dvh", background: "#000000", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {styleTag}
        <div style={{ color: "#F2F2F2", textAlign: "center" }}>
          <Disc size={64} spin />
          <div className="serif" style={{ marginTop: 12, fontSize: 18 }}>Crate Digging</div>
        </div>
      </div>
    );
  }

  if (showAuth && !currentUser) {
    return (
      <>
        {styleTag}
        <AuthScreen authTab={authTab} setAuthTab={setAuthTab} recentEmails={recentEmails} onLogin={login} onRegister={register}
          reason={authReason} initialRole={authInitialRole}
          onBack={() => { setShowAuth(false); setAuthReason(null); setPendingAction(null); }} />
      </>
    );
  }

  const isOwner = !!currentUser && currentUser.role === "owner";
  const isGuest = !currentUser;
  const saved = currentUser ? wants.filter((w) => w.buyerId === currentUser.id).map((w) => w.releaseId) : [];
  const savedSet = new Set(saved);
  const savedDiscogsIds = new Set(saved.map((id) => relById[id] && relById[id].discogsId).filter(Boolean));

  // ---- buyer screens ----
  const RecordRow = ({ r, shops, min }) => (
    <div className="row card" style={{ padding: "10px 12px", marginBottom: 8, cursor: "pointer" }} onClick={() => setBScreen({ name: "detail", releaseId: r.id })}>
      <Sleeve release={r} size={46} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="serif" style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
        <div className="k">{joinDot([r.artist, r.year])}</div>
        <div className="k" style={{ marginTop: 3 }}>{shops} shop{shops > 1 ? "s" : ""} · in-store only</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div className="k">from</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--rust)" }}>€{min}</div>
      </div>
    </div>
  );

  // group a set of available listings into release rows for RecordRow
  const rowsFromListings = (ls) => {
    const byRel = {};
    ls.forEach((l) => { (byRel[l.releaseId] = byRel[l.releaseId] || []).push(l); });
    return Object.keys(byRel).map((rid) => {
      const arr = byRel[rid];
      return { release: relById[rid], shops: arr.length, min: Math.min(...arr.map(effPrice)) };
    }).filter((x) => x.release).sort((a, b) => a.release.title.localeCompare(b.release.title));
  };

  const browseRows = () => {
    const avail = listings.filter((l) => l.status === "available");
    if (!browse) return [];
    if (browse.type === "new") { const cut = Date.now() - 14 * 86400000; return rowsFromListings(avail.filter((l) => l.created && new Date(l.created).getTime() >= cut)); }
    if (browse.type === "sale") return rowsFromListings(avail.filter((l) => l.discount && l.discount.pct > 0));
    if (browse.type === "cheap") return rowsFromListings(avail.filter((l) => effPrice(l) < 20));
    if (browse.type === "hood") return rowsFromListings(avail.filter((l) => { const s = shopById[l.shopId]; return s && s.hood === browse.value; }));
    if (browse.type === "genre") return rowsFromListings(avail.filter((l) => { const r = relById[l.releaseId]; return r && (r.genre || "").toLowerCase() === browse.value; }));
    return [];
  };

  const BrowseTiles = () => {
    const avail = listings.filter((l) => l.status === "available");
    const has = (pred) => avail.some(pred);
    const tiles = [];
    const cut = Date.now() - 14 * 86400000;
    if (has((l) => l.created && new Date(l.created).getTime() >= cut)) tiles.push({ type: "new", label: "New arrivals", c1: "#1B2A4A", c2: "#5FA0B4" });
    if (has((l) => l.discount && l.discount.pct > 0)) tiles.push({ type: "sale", label: "On sale", c1: "#3A1F2B", c2: "#E0673C" });
    if (has((l) => effPrice(l) < 20)) tiles.push({ type: "cheap", label: "Under €20", c1: "#243027", c2: "#B4C47F" });
    // genres present
    const genres = [];
    avail.forEach((l) => { const r = relById[l.releaseId]; const g = r && (r.genre || "").trim(); if (g && !genres.some((x) => x.toLowerCase() === g.toLowerCase())) genres.push(g); });
    const gcolors = [["#2E2416", "#E0A13C"], ["#20161F", "#E0673C"], ["#12222E", "#7FB2C4"], ["#241C3A", "#8A7FC4"], ["#2A2018", "#C4632E"], ["#1E2A24", "#B4C47F"], ["#141414", "#E0673C"], ["#16242E", "#5FA0B4"]];
    genres.sort().forEach((g, i) => tiles.push({ type: "genre", value: g.toLowerCase(), label: g, c1: gcolors[i % gcolors.length][0], c2: gcolors[i % gcolors.length][1] }));

    if (tiles.length === 0) {
      return (
        <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--muted)" }}>
          <Disc size={54} />
          <div style={{ fontSize: 15, marginTop: 16, lineHeight: 1.5 }}>Let's dig through the crates<br />and find your perfect record.</div>
        </div>
      );
    }
    return (
      <>
        <div className="k" style={{ margin: "2px 2px 12px" }}>Browse the crates</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {tiles.map((t, i) => (
            t.type === "genre" ? (
              <div key={t.type + (t.value || "") + i} role="button"
                onClick={() => setBrowse({ type: t.type, value: t.value, label: t.label })}
                style={{ height: 92, borderRadius: 12, cursor: "pointer", background: "var(--card)", border: "0.5px solid var(--line)",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px" }}>
                <GenreDisc genre={t.label} ring={t.c2} size={40} />
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", textAlign: "center", lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{t.label}</span>
              </div>
            ) : (
              <div key={t.type + (t.value || "") + i} role="button"
                onClick={() => setBrowse({ type: t.type, value: t.value, label: t.label })}
                style={{ position: "relative", height: 92, borderRadius: 12, cursor: "pointer", overflow: "hidden",
                  background: `linear-gradient(135deg, ${t.c1}, ${t.c2})`, padding: "12px 13px" }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#fff", lineHeight: 1.2, textShadow: "0 1px 3px rgba(0,0,0,.35)" }}>{t.label}</span>
              </div>
            )
          ))}
        </div>
      </>
    );
  };

  const BuyerSearch = () => {
    const rows = browse ? browseRows() : [];
    if (catalogOpen) {
      return <BuyerCatalog seed={query} savedDiscogsIds={savedDiscogsIds}
        onBack={() => setCatalogOpen(false)}
        onSave={(res) => requireAuth("to build your hunting list", () => saveCatalogRecord(res))} />;
    }
    return (
      <div style={{ padding: "6px 18px 20px" }}>
        <div className="row card" style={{ padding: "10px 12px", marginBottom: 14 }}>
          <span style={{ color: "var(--muted)" }}>⌕</span>
          <input value={query} onChange={(e) => { setQuery(e.target.value); if (browse) setBrowse(null); }} placeholder="Search artist or title" autoFocus
            style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
        </div>
        {query.trim() ? (
          searchResults.length === 0 ? (
            <div className="k" style={{ textAlign: "center", padding: "40px 20px" }}>No records match that. Try another artist or title.</div>
          ) : searchResults.map((x) => <RecordRow key={x.release.id} r={x.release} shops={x.shops} min={x.min} />)
        ) : browse ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span role="button" onClick={() => setBrowse(null)} style={{ fontSize: 22, cursor: "pointer" }}>‹</span>
              <span style={{ fontSize: 18, fontWeight: 600 }}>{browse.label}</span>
            </div>
            {rows.length === 0 ? (
              <div className="k" style={{ textAlign: "center", padding: "40px 20px" }}>Nothing here right now.</div>
            ) : rows.map((x) => <RecordRow key={x.release.id} r={x.release} shops={x.shops} min={x.min} />)}
          </>
        ) : (
          BrowseTiles()
        )}
        <div role="button" onClick={() => setCatalogOpen(true)}
          style={{ marginTop: 18, textAlign: "center", fontSize: 13, color: "var(--rust)", cursor: "pointer", padding: "10px" }}>
          Can't find it? Search the full catalog →
        </div>
      </div>
    );
  };

  const BuyerDetail = () => {
    const r = relById[bScreen.releaseId];
    if (!r) return null;
    const rows = listings.filter((l) => l.releaseId === r.id && l.status !== "sold");
    const isSaved = savedSet.has(r.id);
    return (
      <div className="scroll">
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 16px 0" }}>
          <span role="button" onClick={() => setBScreen(bScreen.from === "shop" ? { name: "shop", shopId: bScreen.shopId } : { name: "search" })} style={{ fontSize: 22, cursor: "pointer" }}>‹</span>
          <span role="button" onClick={() => requireAuth("to save records", () => toggleSave(r.id))} style={{ fontSize: 20, cursor: "pointer", color: isSaved ? "var(--rust)" : "var(--faint)" }}>{isSaved ? "♥" : "♡"}</span>
        </div>
        <div style={{ position: "relative", height: 170, margin: "4px 18px 0" }}>
          <div style={{ position: "absolute", right: 18, top: 12 }}><Disc size={140} label={r.cover[1]} spin /></div>
          <div style={{ position: "absolute", left: 0, top: 6 }}><Sleeve release={r} size={150} /></div>
        </div>
        <div style={{ padding: "6px 20px 0" }}>
          <div style={{ fontSize: 12, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>{r.artist}</div>
          <div className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.2, marginTop: 2 }}>{r.title}</div>
          <div className="k" style={{ marginTop: 4 }}>{joinDot([r.year, r.format, r.genre])}</div>
        </div>
        <a href={r.youtubeUrl || ytLink(r)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
          <div className="row card" style={{ margin: "12px 16px 0", padding: "10px 12px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: "50%", background: "var(--rust)", color: "var(--cream)", flexShrink: 0 }}>▶</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{r.youtubeUrl ? "Play preview" : "Preview on YouTube"}</div>
              <div className="k">opens outside the app</div>
            </div>
            <span className="k">↗</span>
          </div>
        </a>
        {r.tracklist && r.tracklist.length > 0 && (
          <div style={{ padding: "18px 20px 0" }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Tracklist</div>
            {r.tracklist.map((side, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div className="k" style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4 }}>Side {side.label}</div>
                {side.tracks.map((t, j) => (
                  <div key={j} style={{ display: "flex", gap: 10, fontSize: 14, padding: "3px 0" }}>
                    <span className="k" style={{ width: 16, flexShrink: 0 }}>{j + 1}</span>
                    <span>{t}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "18px 20px 8px" }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Available in Berlin</span>
          <span className="k">{rows.filter((l) => l.status === "available").length} shops</span>
        </div>
        <div style={{ padding: "0 16px 24px" }}>
          {rows.map((l) => {
            const s = shopById[l.shopId];
            return (
              <div key={l.id} className="card" style={{ padding: "12px 13px", marginBottom: 8, display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div role="button" onClick={() => setBScreen({ name: "shop", shopId: l.shopId })} style={{ flex: 1, minWidth: 0, cursor: "pointer", textAlign: "left" }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "var(--rust)" }}>{s.name} ›</div>
                  <div className="k" style={{ marginTop: 2 }}>{joinDot([s.hood, s.address])}</div>
                  <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="k" style={{ fontSize: 11, background: "#1E1E1E", color: "#9A9A9A", padding: "2px 8px", borderRadius: 999 }}>{l.condition}</span>
                    <span style={{ fontSize: 11, color: "#E0955F", background: "#2A1D14", padding: "2px 8px", borderRadius: 999 }}>In-store only</span>
                    <DiscountBadge listing={l} />
                  </div>
                  <div className="k" style={{ fontSize: 11, marginTop: 7 }}>updated {rel(l.updated)}</div>
                </div>
                <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }}>
                  <PriceTag listing={l} size={17} />
                  {l.status === "available" ? (
                    <button className="btn-ghost" style={{ padding: "5px 13px", fontSize: 12 }} onClick={() => requireAuth("to reserve this record", () => reserve(l))}>Reserve</button>
                  ) : (
                    <StatusPill status={l.status} />
                  )}
                </div>
              </div>
            );
          })}
          <div className="k" style={{ fontSize: 11, textAlign: "center", marginTop: 6 }}>Reserving holds a copy — pickup and payment happen in the shop.</div>
        </div>
      </div>
    );
  };

  const BuyerSaved = () => {
    const items = saved.map((id) => relById[id]).filter(Boolean).map((r) => {
      const avail = listings.filter((l) => l.releaseId === r.id && l.status === "available");
      const shopIds = new Set(avail.map((l) => l.shopId));
      return { r, count: shopIds.size, min: avail.length ? Math.min(...avail.map(effPrice)) : null, available: shopIds.size > 0 };
    });
    const availItems = items.filter((x) => x.available).sort((a, b) => a.min - b.min);
    const waitItems = items.filter((x) => !x.available);
    if (items.length === 0) {
      return (
        <div style={{ padding: "10px 18px 20px" }}>
          <EmptyState text="Your hunting list is empty. Tap the heart on any record — even ones no shop has yet — and we'll tell you when it turns up." actionLabel="Search the catalog" onAction={() => { setBScreen({ name: "search" }); setCatalogOpen(true); }} />
        </div>
      );
    }
    return (
      <div style={{ padding: "10px 18px 20px" }}>
        <div style={{ fontSize: 22, fontWeight: 600, margin: "6px 0 2px" }}>Your hunting list</div>
        <div className="k" style={{ marginBottom: 14 }}>{availItems.length} of {items.length} available in Berlin now</div>
        {availItems.map(({ r, count, min }) => (
          <div key={r.id} className="row card" style={{ padding: "10px 12px", marginBottom: 8, cursor: "pointer" }} onClick={() => setBScreen({ name: "detail", releaseId: r.id })}>
            <Sleeve release={r} size={46} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="serif" style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
              <div className="k">{joinDot([r.artist, r.year])}</div>
              <div style={{ fontSize: 12, marginTop: 4, color: "#7FCBA0", fontWeight: 600 }}>● in {count} shop{count > 1 ? "s" : ""} now</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div className="k">from</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--rust)" }}>€{min}</div>
            </div>
          </div>
        ))}
        {waitItems.length > 0 && (
          <>
            <div className="k" style={{ margin: "18px 2px 8px", textTransform: "uppercase", letterSpacing: ".05em", fontSize: 11 }}>Still hunting</div>
            {waitItems.map(({ r }) => (
              <div key={r.id} className="row card" style={{ padding: "10px 12px", marginBottom: 8, cursor: "pointer", opacity: 0.72 }} onClick={() => setBScreen({ name: "detail", releaseId: r.id })}>
                <Sleeve release={r} size={46} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="serif" style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                  <div className="k">{joinDot([r.artist, r.year])}</div>
                  <div style={{ fontSize: 12, marginTop: 4, color: "var(--muted)" }}>No shop has it yet — we'll show it here</div>
                </div>
                <span role="button" onClick={(e) => { e.stopPropagation(); toggleSave(r.id); }} style={{ fontSize: 18, color: "var(--rust)", cursor: "pointer", flexShrink: 0 }}>♥</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  };

  const BuyerReserved = () => {
    const held = reservations.filter((r) => (r.status === "held" || r.status === "pending" || r.status === "expired") && r.buyerId === currentUser.id)
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    return (
      <div style={{ padding: "10px 18px 20px" }}>
        {held.length === 0 ? (
          <EmptyState text="No reservations yet. Find a record and pick it up in store." actionLabel="Find records" onAction={() => setBScreen({ name: "search" })} />
        ) : (
          held.map((res) => {
            const r = relById[res.releaseId]; const s = shopById[res.shopId];
            const countdown = res.status === "held" && res.holdUntil ? fmtCountdown(res.holdUntil, nowTick) : null;
            let line, pill;
            if (res.status === "pending") { line = "waiting for the shop to accept"; pill = "pending"; }
            else if (res.status === "expired") { line = "hold expired — back on the shelf"; pill = "expired"; }
            else { line = countdown ? `pick up within ${countdown}` : "ready to pick up in store"; pill = "reserved"; }
            return (
              <div key={res.id} className="card" style={{ padding: "11px 13px", marginBottom: 8, opacity: res.status === "expired" ? 0.6 : 1 }}>
                <div className="row">
                  <Sleeve release={r} size={46} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="serif" style={{ fontSize: 15, fontWeight: 600 }}>{r.title}</div>
                    <div className="k">{joinDot([s.name, s.hood])}</div>
                    <div className="k" style={{ fontSize: 11, marginTop: 3, color: countdown ? "var(--rust)" : "var(--muted)" }}>{line}</div>
                  </div>
                  {pill === "expired"
                    ? <span className="k" style={{ fontSize: 11, background: "#1E1E1E", color: "#9A9A9A", padding: "3px 9px", borderRadius: 999 }}>Expired</span>
                    : <StatusPill status={pill} />}
                </div>
                {res.status !== "expired" && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "0.5px solid var(--line)" }}>
                    <span role="button" onClick={() => setBScreen({ name: "thread", shopId: res.shopId, from: "messages" })} style={{ fontSize: 13, color: "var(--rust)", cursor: "pointer" }}>Message shop ✉</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    );
  };

  // ---- stores + shop (buyer) ----
  const shopStock = (id) => listings.filter((l) => l.shopId === id && l.status === "available").length;
  const gmapsUrl = (s) =>
    s.mapsUrl
      ? s.mapsUrl
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address ? `${s.address}` : `${s.name} ${s.hood || ""} Berlin`)}`;

  const StoresScreen = () => {
    const shops = catalog.shops
      .filter((s) => listings.some((l) => l.shopId === s.id)) // only shops actually selling on the app
      .map((s) => ({ s, n: shopStock(s.id) }))
      .sort((a, b) => b.n - a.n || a.s.name.localeCompare(b.s.name));
    return (
      <div style={{ padding: "6px 18px 20px" }}>
        <div style={{ fontSize: 22, fontWeight: 600, margin: "6px 0 2px" }}>Stores</div>
        <div className="k" style={{ marginBottom: 14 }}>Record shops selling on Crate Digging</div>
        {shops.length === 0 ? (
          <EmptyState text="No shops are selling yet. Be the first to dig — search the crates." actionLabel="Search records" onAction={() => setBScreen({ name: "search" })} />
        ) : shops.map(({ s, n }) => (
          <div key={s.id} className="card" style={{ padding: "12px 13px", marginBottom: 8 }}>
            <div className="row" style={{ cursor: "pointer" }} onClick={() => setBScreen({ name: "shop", shopId: s.id })}>
              <span style={{ width: 38, height: 38, flexShrink: 0, display: "inline-flex" }}>
                <svg width="38" height="38" viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="50" r="48" fill="#1C1C1C" />
                  <circle cx="50" cy="50" r="30" fill="none" stroke="#3A3A3A" strokeWidth="1" />
                  <circle cx="50" cy="50" r="14" fill="none" stroke={s.vinylColor || DEFAULT_VINYL} strokeWidth="4" />
                  <circle cx="50" cy="50" r="3" fill="#0F0F0F" />
                </svg>
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{s.name}</div>
                <div className="k">{s.hood}{s.address ? " · " + s.address : ""}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--rust)" }}>{n}</div>
                <div className="k" style={{ fontSize: 11 }}>in stock</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--line)" }}>
              <span role="button" onClick={() => setBScreen({ name: "shop", shopId: s.id })} style={{ fontSize: 13, color: "var(--rust)", cursor: "pointer" }}>View records</span>
              <a href={gmapsUrl(s)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>Open in Google Maps ↗</a>
            </div>
          </div>
        ))}
        {isGuest && (
          <div className="card" style={{ padding: "16px 15px", marginTop: 16, textAlign: "center" }}>
            <div className="serif" style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Own a record shop?</div>
            <div className="k" style={{ marginBottom: 12, lineHeight: 1.5 }}>List your stock for free and let Berlin diggers find you. Take reservations and message buyers, all in one place.</div>
            <button className="btn-rust" style={{ width: "auto", padding: "9px 18px" }} onClick={() => openAuth("register", "owner", "to list your shop")}>List your shop</button>
          </div>
        )}
      </div>
    );
  };

  const ShopScreen = () => {
    const s = shopById[bScreen.shopId];
    if (!s) return null;
    const all = listings.filter((l) => l.shopId === s.id && l.status !== "sold");
    const availCount = all.filter((l) => l.status === "available").length;
    const q = shopQuery.trim().toLowerCase();

    // genres actually present in this shop's stock (data-driven dropdown)
    const shopGenres = [];
    all.forEach((l) => { const r = relById[l.releaseId]; const g = r && (r.genre || "").trim(); if (g && !shopGenres.some((x) => x.toLowerCase() === g.toLowerCase())) shopGenres.push(g); });
    shopGenres.sort();
    const genreActive = shopGenre !== "all" && shopGenres.some((g) => g.toLowerCase() === shopGenre); // ignore stale filter from another shop

    let recs = all.filter((l) => {
      if (q) { const r = relById[l.releaseId]; if (!r || !((r.artist || "").toLowerCase().includes(q) || (r.title || "").toLowerCase().includes(q))) return false; }
      if (genreActive) { const r = relById[l.releaseId]; if (!r || (r.genre || "").toLowerCase() !== shopGenre) return false; }
      return true;
    });
    recs = recs.slice().sort((a, b) => {
      if (shopSort === "price-asc") return effPrice(a) - effPrice(b);
      if (shopSort === "price-desc") return effPrice(b) - effPrice(a);
      return new Date(b.created || 0) - new Date(a.created || 0); // recent
    });

    const selStyle = { fontSize: 12, background: "var(--card)", color: "var(--ink)", border: "0.5px solid var(--line)", borderRadius: 999, padding: "7px 10px", cursor: "pointer" };
    return (
      <div className="scroll">
        <div style={{ padding: "8px 16px 0" }}>
          <span role="button" onClick={() => { setShopQuery(""); setShopGenre("all"); setBScreen({ name: "stores" }); }} style={{ fontSize: 22, cursor: "pointer" }}>‹</span>
        </div>
        <div style={{ padding: "4px 20px 0" }}>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{s.name}</div>
          <div className="k" style={{ marginTop: 5 }}>{s.hood}{s.address ? " · " + s.address : ""}</div>
          <div className="k" style={{ marginTop: 2 }}>{availCount} record{availCount === 1 ? "" : "s"} available · in-store pickup only</div>
          <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
            <a href={gmapsUrl(s)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "var(--rust)", textDecoration: "none" }}>Open in Google Maps ↗</a>
            <span role="button" onClick={() => requireAuth("to message this shop", () => setBScreen({ name: "thread", shopId: s.id, from: "shop" }))} style={{ fontSize: 13, color: "var(--rust)", cursor: "pointer" }}>Message shop ✉</span>
          </div>
        </div>
        <div style={{ padding: "14px 16px 0" }}>
          <div className="row card" style={{ padding: "9px 12px" }}>
            <span style={{ color: "var(--muted)" }}>⌕</span>
            <input value={shopQuery} onChange={(e) => setShopQuery(e.target.value)} placeholder="Search this shop"
              style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {shopGenres.length > 0 && (
              <select value={genreActive ? shopGenre : "all"} onChange={(e) => setShopGenre(e.target.value)} style={selStyle}>
                <option value="all">All genres</option>
                {shopGenres.map((g) => <option key={g} value={g.toLowerCase()}>{g}</option>)}
              </select>
            )}
            <select value={shopSort} onChange={(e) => setShopSort(e.target.value)} style={selStyle}>
              <option value="recent">Recently added</option>
              <option value="price-asc">Price: low → high</option>
              <option value="price-desc">Price: high → low</option>
            </select>
          </div>
        </div>
        <div style={{ padding: "14px 16px 24px" }}>
          {recs.length === 0 ? (
            <div className="k" style={{ textAlign: "center", padding: "34px 20px" }}>{all.length === 0 ? "This shop hasn't listed any records yet." : "No records match that."}</div>
          ) : recs.map((l) => {
            const r = relById[l.releaseId];
            return (
              <div key={l.id} className="row card" style={{ padding: "10px 12px", marginBottom: 8 }}>
                <div role="button" onClick={() => setBScreen({ name: "detail", releaseId: l.releaseId, from: "shop", shopId: s.id })}
                  style={{ display: "flex", gap: 11, flex: 1, minWidth: 0, cursor: "pointer", alignItems: "center" }}>
                  <Sleeve release={r} size={44} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                    <div className="k">{joinDot([r.artist, r.year, l.condition])}</div>
                    {l.discount ? <div style={{ marginTop: 5 }}><DiscountBadge listing={l} /></div> : null}
                  </div>
                </div>
                <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12 }}>
                  <PriceTag listing={l} size={15} />
                  {l.status === "available" ? (
                    <button className="btn-ghost" style={{ padding: "5px 13px", fontSize: 12 }} onClick={() => requireAuth("to reserve this record", () => reserve(l))}>Reserve</button>
                  ) : (
                    <StatusPill status={l.status} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ---- owner screens ----
  const myShopId = currentUser ? currentUser.shopId : null;
  const myListings = listings.filter((l) => l.shopId === myShopId);
  const myShop = shopById[myShopId];

  const OwnerStock = () => (
    <div style={{ padding: "6px 18px 20px" }}>
      {!hideGenreNote && (
        <div className="card" style={{ padding: "11px 12px", marginBottom: 12, display: "flex", alignItems: "flex-start", gap: 10, borderColor: "var(--rust)" }}>
          <span style={{ fontSize: 15, flexShrink: 0, color: "var(--rust)" }}>◆</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.45, color: "var(--ink)" }}>
            Tip: add a <b>genre</b> when you list a record — buyers browse by genre, so it helps them find your stock.
          </div>
          <span role="button" onClick={() => { setHideGenreNote(true); try { localStorage.setItem("cd:hide_genre_note", "1"); } catch { /* ignore */ } }}
            className="k" style={{ cursor: "pointer", fontSize: 16, lineHeight: 1, flexShrink: 0 }}>✕</span>
        </div>
      )}
      <div className="card" style={{ padding: "10px 13px", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 8, background: "var(--rust)", color: "var(--cream)", flexShrink: 0 }}>◉</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{myShop ? myShop.name : "Your shop"}</div>
          <div className="k">{myShop ? myShop.hood : ""} · you're the owner</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ background: "#151515", borderRadius: 10, padding: "10px 12px" }}>
          <div className="k">In stock</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{myListings.filter((l) => l.status === "available").length}</div>
        </div>
        <div style={{ background: "#151515", borderRadius: 10, padding: "10px 12px" }}>
          <div className="k">Reserved</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{myListings.filter((l) => l.status === "reserved").length}</div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 0 4px" }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Your records</span>
        <div style={{ display: "flex", gap: 8 }}>
          <label className="btn-ghost" style={{ width: "auto", padding: "7px 12px", fontSize: 13, cursor: "pointer" }}>
            Import CSV
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) importCSV(f); e.target.value = ""; }} />
          </label>
          <button className="btn-rust" style={{ width: "auto", padding: "7px 14px", fontSize: 13 }} onClick={() => setOScreen({ name: "add" })}>+ Add</button>
        </div>
      </div>
      <div className="k" style={{ fontSize: 11, marginBottom: 10 }}>
        Bulk add via CSV — columns: artist, title, price ·{" "}
        <a href={"data:text/csv;charset=utf-8," + encodeURIComponent("artist,title,price\nDexter Halloway,Nightgardens,28\nMara Vey,Slow Light,35\n")} download="crate-digging-template.csv" style={{ color: "var(--rust)", textDecoration: "none" }}>Download template</a>
      </div>

      <div className="row card" style={{ padding: "9px 12px", marginBottom: 10 }}>
        <span style={{ color: "var(--muted)" }}>⌕</span>
        <input value={stockQuery} onChange={(e) => setStockQuery(e.target.value)} placeholder="Search your stock"
          style={{ border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, color: "var(--ink)" }} />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto" }}>
        {[["all", "All"], ["available", "Available"], ["pending", "Pending"], ["reserved", "Reserved"], ["sold", "Sold"]].map(([key, label]) => (
          <span key={key} onClick={() => setStockFilter(key)} role="button"
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
              background: stockFilter === key ? "var(--rust)" : "var(--card)", color: stockFilter === key ? "var(--cream)" : "var(--muted)",
              border: "0.5px solid " + (stockFilter === key ? "var(--rust)" : "var(--line)"), fontWeight: stockFilter === key ? 600 : 400 }}>
            {label}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span className="k" style={{ fontSize: 12 }}>Added</span>
        <select value={stockDate} onChange={(e) => setStockDate(e.target.value)}
          style={{ fontSize: 12, background: "var(--card)", color: "var(--ink)", border: "0.5px solid var(--line)", borderRadius: 999, padding: "6px 10px", cursor: "pointer" }}>
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="week">Past week</option>
          <option value="month">Past month</option>
          <option value="older">Older</option>
        </select>
      </div>

      {(() => {
        const q = stockQuery.trim().toLowerCase();
        const now = Date.now();
        const day = 86400000;
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
        const todayMs = startOfToday.getTime();
        const inDate = (l) => {
          if (stockDate === "all") return true;
          const t = l.created ? new Date(l.created).getTime() : 0;
          if (!t) return stockDate === "older";
          if (stockDate === "today") return t >= todayMs;
          if (stockDate === "yesterday") return t >= todayMs - day && t < todayMs;
          if (stockDate === "week") return t >= now - 7 * day;
          if (stockDate === "month") return t >= now - 30 * day;
          if (stockDate === "older") return t < now - 30 * day;
          return true;
        };
        const shown = myListings.filter((l) => {
          if (stockFilter !== "all" && l.status !== stockFilter) return false;
          if (!inDate(l)) return false;
          if (!q) return true;
          const r = relById[l.releaseId];
          return `${r?.artist} ${r?.title}`.toLowerCase().includes(q);
        });
        if (myListings.length === 0) return <div className="k" style={{ textAlign: "center", padding: "30px 20px" }}>No records yet. Add your first one.</div>;
        if (shown.length === 0) return <div className="k" style={{ textAlign: "center", padding: "30px 20px" }}>Nothing matches that filter.</div>;
        return shown.map((l) => {
          const r = relById[l.releaseId];
          return (
            <div key={l.id} className="row card" style={{ padding: "10px 12px", marginBottom: 8 }}>
              <Sleeve release={r} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                <div className="k">{r.artist} · {l.condition}</div>
                <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <SourceBadge source={l.source} />
                  <DiscountBadge listing={l} />
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <PriceTag listing={l} size={15} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", marginTop: 6 }}>
                  {l.status === "pending" ? (
                    <StatusPill status="pending" />
                  ) : (
                    <select value={l.status} onChange={(e) => setListingStatus(l.id, e.target.value)}
                      style={{ fontSize: 12, fontWeight: 600, background: STATUS_COLORS[l.status].bg, color: STATUS_COLORS[l.status].fg, border: "none", borderRadius: 999, padding: "3px 6px", cursor: "pointer" }}>
                      <option value="available">Available</option>
                      <option value="reserved">Reserved</option>
                      <option value="sold">Sold</option>
                    </select>
                  )}
                  <span role="button" onClick={() => setOScreen({ name: "edit", listingId: l.id })} style={{ cursor: "pointer", color: "var(--muted)", fontSize: 14 }}>✎</span>
                </div>
                <div className="k" style={{ fontSize: 11, marginTop: 4 }}>updated {rel(l.updated)}</div>
              </div>
            </div>
          );
        });
      })()}
    </div>
  );

  const OwnerReservations = () => {
    const pending = reservations.filter((res) => res.shopId === myShopId && res.status === "pending");
    const held = reservations.filter((res) => res.shopId === myShopId && res.status === "held");
    const Card = ({ res, children }) => {
      const r = relById[res.releaseId];
      return (
        <div className="card" style={{ padding: "11px 13px", marginBottom: 8 }}>
          <div className="row">
            <Sleeve release={r} size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="serif" style={{ fontSize: 15, fontWeight: 600 }}>{r.title}</div>
              <div className="k">{r.artist} · requested {rel(res.created)}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>{children}</div>
        </div>
      );
    };
    return (
      <div style={{ padding: "10px 18px 20px" }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Requests to approve</div>
        {pending.length === 0 ? (
          <div className="k" style={{ textAlign: "center", padding: "20px" }}>No new requests.</div>
        ) : (
          pending.map((res) => (
            <Card key={res.id} res={res}>
              <button className="btn-rust" style={{ padding: "9px 0", fontSize: 13 }} onClick={() => acceptReservation(res)}>Accept</button>
              <button className="btn-ghost" style={{ flex: 1, padding: "9px 0", fontSize: 13 }} onClick={() => declineReservation(res)}>Decline</button>
            </Card>
          ))
        )}

        <div style={{ fontSize: 15, fontWeight: 600, margin: "18px 0 10px" }}>Pickups waiting</div>
        {held.length === 0 ? (
          <div className="k" style={{ textAlign: "center", padding: "20px" }}>No pickups waiting.</div>
        ) : (
          held.map((res) => {
            const cd = res.holdUntil ? fmtCountdown(res.holdUntil, nowTick) : null;
            return (
              <Card key={res.id} res={res}>
                <div style={{ width: "100%" }}>
                  <div className="k" style={{ fontSize: 11, marginBottom: 8, color: cd ? "var(--rust)" : "var(--muted)" }}>
                    {cd ? `Held — ${cd} left to pick up` : "Held"}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-rust" style={{ padding: "9px 0", fontSize: 13, flex: 1 }} onClick={() => markPickedUp(res)}>Mark picked up</button>
                    <button className="btn-ghost" style={{ flex: 1, padding: "9px 0", fontSize: 13 }} onClick={() => cancelReservation(res)}>Release</button>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    );
  };

  const OwnerSettings = () => (
    <div style={{ padding: "14px 18px 20px" }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Settings</div>
      <div className="card" style={{ padding: "12px 14px", marginBottom: 12 }}>
        <div className="k">Signed in as</div>
        <div className="k" style={{ marginTop: 2 }}>{currentUser.email}</div>
      </div>
      <NameEditor initial={currentUser.name} onSave={updateName} />
      <ShopEditor key={myShop ? myShop.id : "none"} shop={myShop} onSave={updateShop} />
      <div className="k" style={{ marginBottom: 12 }}>Stock and reservations are shared — every visitor to the app sees them. Your saved records stay private to your account.</div>
      <button className="btn-ghost" style={{ width: "100%" }} onClick={logout}>Log out</button>
    </div>
  );

  // ---- messaging screens ----
  const BuyerMessages = () => {
    const mine = messages.filter((m) => m.buyerId === (currentUser && currentUser.id));
    const byShop = {};
    mine.forEach((m) => { (byShop[m.shopId] = byShop[m.shopId] || []).push(m); });
    const threads = Object.keys(byShop).map((sid) => {
      const arr = byShop[sid].slice().sort((a, b) => new Date(a.created) - new Date(b.created));
      return { shopId: sid, last: arr[arr.length - 1] };
    }).sort((a, b) => new Date(b.last.created) - new Date(a.last.created));
    return (
      <div style={{ padding: "6px 18px 20px" }}>
        <div style={{ fontSize: 22, fontWeight: 600, margin: "6px 0 14px" }}>Messages</div>
        {threads.length === 0 ? (
          <EmptyState text="No messages yet. Open a shop and tap “Message shop” to start a conversation." actionLabel="Browse shops" onAction={() => setBScreen({ name: "stores" })} />
        ) : threads.map((t) => {
          const s = shopById[t.shopId];
          return (
            <div key={t.shopId} className="row card" style={{ padding: "12px 13px", marginBottom: 8, cursor: "pointer" }} onClick={() => setBScreen({ name: "thread", shopId: t.shopId, from: "messages" })}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 999, background: "var(--rust)", color: "var(--cream)", flexShrink: 0 }}>✉</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{s ? s.name : "Shop"}</div>
                <div className="k" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.last.sender === "buyer" ? "You: " : ""}{t.last.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const BuyerThread = () => {
    const s = shopById[bScreen.shopId];
    const msgs = messages.filter((m) => m.buyerId === (currentUser && currentUser.id) && m.shopId === bScreen.shopId)
      .slice().sort((a, b) => new Date(a.created) - new Date(b.created));
    return <Thread title={s ? s.name : "Shop"} subtitle={s ? s.hood : ""} messages={msgs} meSender="buyer"
      onBack={() => setBScreen(bScreen.from === "shop" ? { name: "shop", shopId: bScreen.shopId } : { name: "messages" })}
      onRefresh={loadMessages} onSeen={() => markThreadSeen(bScreen.shopId + ":" + currentUser.id)}
      onSend={(body) => sendMessage(bScreen.shopId, currentUser.id, "buyer", body)} />;
  };

  const OwnerMessages = () => {
    const mine = messages.filter((m) => m.shopId === myShopId);
    const byBuyer = {};
    mine.forEach((m) => { (byBuyer[m.buyerId] = byBuyer[m.buyerId] || []).push(m); });
    const threads = Object.keys(byBuyer).map((bid) => {
      const arr = byBuyer[bid].slice().sort((a, b) => new Date(a.created) - new Date(b.created));
      const nameMsg = arr.find((m) => m.sender === "buyer" && m.senderName);
      return { buyerId: bid, name: nameMsg ? nameMsg.senderName : "Buyer", last: arr[arr.length - 1] };
    }).sort((a, b) => new Date(b.last.created) - new Date(a.last.created));
    return (
      <div style={{ padding: "6px 18px 20px" }}>
        <div style={{ fontSize: 22, fontWeight: 600, margin: "6px 0 14px" }}>Messages</div>
        {threads.length === 0 ? (
          <div className="k" style={{ textAlign: "center", padding: "40px 20px" }}>No messages yet. Buyers can message you from your shop page.</div>
        ) : threads.map((t) => (
          <div key={t.buyerId} className="row card" style={{ padding: "12px 13px", marginBottom: 8, cursor: "pointer" }} onClick={() => setOScreen({ name: "thread", buyerId: t.buyerId })}>
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 999, background: "var(--rust)", color: "var(--cream)", flexShrink: 0 }}>✉</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{t.name}</div>
              <div className="k" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.last.sender === "owner" ? "You: " : ""}{t.last.body}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const OwnerThread = () => {
    const msgs = messages.filter((m) => m.shopId === myShopId && m.buyerId === oScreen.buyerId)
      .slice().sort((a, b) => new Date(a.created) - new Date(b.created));
    const nameMsg = msgs.find((m) => m.sender === "buyer" && m.senderName);
    return <Thread title={nameMsg ? nameMsg.senderName : "Buyer"} messages={msgs} meSender="owner"
      onBack={() => setOScreen({ name: "messages" })} onRefresh={loadMessages}
      onSeen={() => markThreadSeen(myShopId + ":" + oScreen.buyerId)}
      onSend={(body) => sendMessage(myShopId, oScreen.buyerId, "owner", body)} />;
  };

  // ---- assembly ----
  // Screens are invoked as functions (not <Comp/>) so they inline into this
  // render — that keeps text inputs from losing focus on each keystroke.
  const GateScreen = (text, reason) => (
    <EmptyState text={text} actionLabel="Sign up" onAction={() => openAuth("register", "buyer", reason)} />
  );

  const buyerContent =
    bScreen.name === "stores" ? StoresScreen()
    : bScreen.name === "shop" ? ShopScreen()
    : bScreen.name === "detail" ? BuyerDetail()
    : bScreen.name === "saved" ? (isGuest ? GateScreen("Sign in to save records you're eyeing.", "to save records") : BuyerSaved())
    : bScreen.name === "reserved" ? (isGuest ? GateScreen("Sign in to reserve records and track your pickups.", "to reserve records") : BuyerReserved())
    : bScreen.name === "profile" ? (isGuest ? GateScreen("Sign in to view your profile.", "to view your profile") : (
        <ProfileScreen
          user={currentUser}
          savedCount={saved.length}
          reservedCount={reservations.filter((r) => r.buyerId === currentUser.id && (r.status === "pending" || r.status === "held")).length}
          onSaveName={updateName}
          onLogout={logout}
          onBack={() => setBScreen({ name: "stores" })}
          onOpenSaved={() => setBScreen({ name: "saved" })}
          onOpenReserved={() => setBScreen({ name: "reserved" })}
        />
      ))
    : bScreen.name === "messages" ? (isGuest ? GateScreen("Sign in to message shops directly.", "to message shops") : BuyerMessages())
    : bScreen.name === "thread" ? (isGuest ? GateScreen("Sign in to message shops directly.", "to message shops") : BuyerThread())
    : BuyerSearch();
  const OwnerWanted = () => {
    const counts = {};
    wants.forEach((w) => { counts[w.releaseId] = (counts[w.releaseId] || 0) + 1; });
    const rows = Object.keys(counts).map((rid) => ({
      rid, r: relById[rid], count: counts[rid],
      inStock: myListings.some((l) => l.releaseId === rid && l.status === "available"),
    })).filter((x) => x.r).sort((a, b) => b.count - a.count);
    return (
      <div style={{ padding: "10px 18px 20px" }}>
        <div style={{ fontSize: 22, fontWeight: 600, margin: "6px 0 2px" }}>Most wanted</div>
        <div className="k" style={{ marginBottom: 14 }}>Records buyers are hunting. Tap notify when you have one in stock.</div>
        {rows.length === 0 ? (
          <EmptyState text="No want-lists yet. As buyers save records they're hunting for, they'll appear here — handy for knowing what to stock." />
        ) : rows.map(({ rid, r, count, inStock }) => (
          <div key={rid} className="card" style={{ padding: "11px 12px", marginBottom: 8 }}>
            <div className="row">
              <Sleeve release={r} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</div>
                <div className="k">{r.artist}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--rust)" }}>{count}</div>
                <div className="k" style={{ fontSize: 10 }}>want it</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--line)" }}>
              {inStock ? (
                <>
                  <span style={{ fontSize: 12, color: "#7FCBA0" }}>● you have this in stock</span>
                  <button className="btn-rust" style={{ marginLeft: "auto", width: "auto", padding: "7px 13px", fontSize: 12 }} onClick={() => notifyWanters(rid)}>Notify {count} buyer{count > 1 ? "s" : ""}</button>
                </>
              ) : (
                <span style={{ fontSize: 12, color: "var(--muted)" }}>○ not in your stock</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const ownerContent =
    oScreen.name === "add" ? <AddRecord releases={catalog.releases} listings={listings} shopId={myShopId} onSave={addRecord} onCancel={() => setOScreen({ name: "stock" })} />
    : oScreen.name === "edit" ? <EditRecord listing={listings.find((l) => l.id === oScreen.listingId)} release={relById[listings.find((l) => l.id === oScreen.listingId)?.releaseId]} onSave={saveEdit} onDelete={deleteListing} onCancel={() => setOScreen({ name: "stock" })} onSetImage={setReleaseImage} onSetTracklist={setReleaseTracklist} onSetPreview={setReleasePreview} onSetGenre={setReleaseGenre} />
    : oScreen.name === "reservations" ? OwnerReservations()
    : oScreen.name === "wanted" ? OwnerWanted()
    : oScreen.name === "messages" ? OwnerMessages()
    : oScreen.name === "thread" ? OwnerThread()
    : oScreen.name === "settings" ? OwnerSettings()
    : OwnerStock();

  const pendingCount = isOwner ? reservations.filter((r) => r.shopId === myShopId && r.status === "pending").length : 0;
  const unreadMsgThreads = (() => {
    const newer = (created, key) => { const seen = msgSeen[key]; return !seen || new Date(created).getTime() > new Date(seen).getTime(); };
    const set = new Set();
    if (isOwner) {
      messages.forEach((m) => { if (m.shopId === myShopId && m.sender === "buyer" && newer(m.created, myShopId + ":" + m.buyerId)) set.add(m.buyerId); });
    } else if (currentUser) {
      messages.forEach((m) => { if (m.buyerId === currentUser.id && m.sender === "owner" && newer(m.created, m.shopId + ":" + currentUser.id)) set.add(m.shopId); });
    }
    return set.size;
  })();
  const buyerTabs = [["stores", "⌂", "Stores"], ["search", "⌕", "Search"], ["messages", "✉", "Messages"], ["reserved", "◷", "Reserved"]];
  const ownerTabs = [["stock", "≣", "Stock"], ["reservations", "◷", "Pickups"], ["wanted", "♥", "Wanted"], ["messages", "✉", "Messages"], ["settings", "⚙", "Shop"]];
  const ownerMode = isOwner;

  return (
    <div className="rille" style={{ height: "100dvh", background: "#000000", display: "flex", justifyContent: "center", overflow: "hidden" }}>
      {styleTag}
      <div style={{ width: "100%", maxWidth: 393, background: "var(--cream)", height: "100dvh", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" }}>

        <div style={{ flexShrink: 0, padding: "16px 18px 12px", paddingTop: "calc(16px + env(safe-area-inset-top))", borderBottom: "0.5px solid var(--line)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Disc size={26} />
              <span className="serif" style={{ fontSize: 20, fontWeight: 600, letterSpacing: ".01em" }}>Crate Digging</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {isGuest ? (
                <span role="button" onClick={() => openAuth("login", "buyer", null)} className="k" style={{ cursor: "pointer", color: "var(--rust)", fontWeight: 600 }}>Log in</span>
              ) : (
                <>
                  {!isOwner && (
                    <span role="button" onClick={() => setBScreen({ name: "saved" })} title="Saved"
                      style={{ cursor: "pointer", fontSize: 18, color: bScreen.name === "saved" ? "var(--rust)" : "var(--muted)" }}>♡</span>
                  )}
                  <span role="button" onClick={() => isOwner ? setOScreen({ name: "settings" }) : setBScreen({ name: "profile" })} className="k" style={{ cursor: "pointer", color: "var(--rust)", fontWeight: 600 }}>{currentUser.name.split(" ")[0]}</span>
                </>
              )}
            </span>
          </div>
        </div>

        <div className="scroll">{ownerMode ? ownerContent : buyerContent}</div>

        {toast && (
          <div style={{ position: "absolute", bottom: 76, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ background: "var(--card)", color: "var(--ink)", border: "0.5px solid var(--line)", fontSize: 13, padding: "8px 16px", borderRadius: 999 }}>{toast}</div>
          </div>
        )}

        <div style={{ flexShrink: 0, display: "flex", padding: "10px 8px 14px", paddingBottom: "calc(14px + env(safe-area-inset-bottom))", background: "var(--panel)", borderTop: "0.5px solid var(--line)" }}>
          {(ownerMode ? ownerTabs : buyerTabs).map(([key, icon, label]) => {
            const active = ownerMode
              ? oScreen.name === key || (key === "stock" && (oScreen.name === "add" || oScreen.name === "edit")) || (key === "messages" && oScreen.name === "thread")
              : bScreen.name === key || (key === "search" && bScreen.name === "detail") || (key === "stores" && bScreen.name === "shop") || (key === "messages" && bScreen.name === "thread");
            return (
              <button key={key} className={"tab" + (active ? " active" : "")} onClick={() => { if (ownerMode) setOScreen({ name: key }); else { setCatalogOpen(false); setBScreen({ name: key }); } }}>
                <span className="tabicon" style={{ position: "relative" }}>
                  {icon}
                  {key === "reservations" && pendingCount > 0 && (
                    <span style={{ position: "absolute", top: -4, right: -10, minWidth: 15, height: 15, padding: "0 3px", borderRadius: 999, background: "var(--rust)", color: "var(--cream)", fontSize: 10, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{pendingCount}</span>
                  )}
                  {key === "messages" && unreadMsgThreads > 0 && (
                    <span style={{ position: "absolute", top: -4, right: -10, minWidth: 15, height: 15, padding: "0 3px", borderRadius: 999, background: "var(--rust)", color: "var(--cream)", fontSize: 10, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{unreadMsgThreads}</span>
                  )}
                </span>
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
