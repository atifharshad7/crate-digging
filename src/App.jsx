import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from './supabaseClient';

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
const mapShop = (s) => ({
  id: s.id,
  name: s.name,
  hood: s.hood,
  address: s.address,
  lat: s.lat,
  lng: s.lng,
  discogs: s.discogs,
  owner_id: s.owner_id,
});
const mapRelease = (r) => ({
  id: r.id,
  artist: r.artist,
  title: r.title,
  year: r.year,
  genre: r.genre,
  format: r.format,
  cover: r.cover || ['#38271F', '#C4632E'],
  image: r.image || undefined,
  youtube_url: r.youtube_url,
  tracklist: r.tracklist || undefined,
});
const mapListing = (l) => ({
  id: l.id,
  shopId: l.shop_id,
  releaseId: l.release_id,
  condition: l.condition,
  price: l.price,
  qty: l.qty,
  status: l.status,
  source: l.source,
  discount: l.discount || undefined,
  updated: l.updated_at,
});
const mapReservation = (r) => ({
  id: r.id,
  listingId: r.listing_id,
  releaseId: r.release_id,
  shopId: r.shop_id,
  buyerId: r.buyer_id,
  status: r.status,
  created: r.created_at,
});

// recent emails for the login screen stay on the device (a convenience, not shared data)
const getRecentEmails = () => {
  try {
    return JSON.parse(localStorage.getItem('cd:recent_emails') || '[]');
  } catch {
    return [];
  }
};
const putRecentEmails = (list) => {
  try {
    localStorage.setItem('cd:recent_emails', JSON.stringify(list));
  } catch {
    /* ignore */
  }
};

const CONDITIONS = ['M', 'NM', 'VG+', 'VG', 'G'];
const STATUS_NEXT = {
  available: 'reserved',
  reserved: 'sold',
  sold: 'available',
};
const STATUS_COLORS = {
  available: { bg: '#13251B', fg: '#7FCBA0' },
  pending: { bg: '#15222E', fg: '#7FB0DE' },
  reserved: { bg: '#2A2416', fg: '#D8B15E' },
  sold: { bg: '#202020', fg: '#8A8A8A' },
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
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function Sleeve({ release, size = 48 }) {
  const [bg, accent] = release?.cover || ['#38271F', '#C4632E'];
  if (release?.image) {
    return (
      <img
        src={release.image}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: 4,
          objectFit: 'cover',
          flexShrink: 0,
          display: 'block',
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: size * 0.46,
          height: size * 0.46,
          borderRadius: '50%',
          background: accent,
        }}
      />
    </div>
  );
}

function Disc({ size = 150, label = '#BF5227', spin = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={spin ? 'spin' : ''}
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="48" fill="#1C1C1C" />
      {[42, 36, 30, 24].map((r) => (
        <circle
          key={r}
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="#3A3A3A"
          strokeWidth="0.4"
        />
      ))}
      <circle
        cx="50"
        cy="50"
        r="15"
        fill="none"
        stroke={label}
        strokeWidth="2.5"
        opacity="0.85"
      />
      <path d="M 50 62 L 43.6 49.4 A 9 9 0 1 1 56.4 49.4 Z" fill="#F2F2F2" />
      <circle cx="50" cy="43" r="3.4" fill="#1C1C1C" />
    </svg>
  );
}

function StatusPill({ status, onClick }) {
  const c = STATUS_COLORS[status];
  const label = status[0].toUpperCase() + status.slice(1);
  return (
    <span
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {label}
      {onClick && <span style={{ fontSize: 10 }}>▾</span>}
    </span>
  );
}

function SourceBadge({ source }) {
  const map = {
    discogs: { bg: '#1E242C', fg: '#9BB0C6', t: 'Discogs' },
    manual: { bg: '#2A1D14', fg: '#E0955F', t: 'Added by you' },
  };
  const s = map[source] || map.manual;
  return (
    <span
      style={{
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
      }}
    >
      {s.t}
    </span>
  );
}

const effPrice = (l) =>
  l.discount && l.discount.pct
    ? Math.round(l.price * (1 - l.discount.pct / 100))
    : l.price;

function PriceTag({ listing, size = 16 }) {
  const has = listing.discount && listing.discount.pct;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {has ? (
        <span
          style={{
            textDecoration: 'line-through',
            color: 'var(--faint)',
            fontSize: size - 3,
            marginRight: 5,
          }}
        >
          €{listing.price}
        </span>
      ) : null}
      <span style={{ fontSize: size, fontWeight: 600, color: 'var(--rust)' }}>
        €{effPrice(listing)}
      </span>
    </span>
  );
}

function DiscountBadge({ listing }) {
  if (!listing.discount) return null;
  const parts = [];
  if (listing.discount.pct) parts.push('−' + listing.discount.pct + '%');
  if (listing.discount.label) parts.push(listing.discount.label);
  if (!parts.length) return null;
  return (
    <span
      style={{
        fontSize: 11,
        color: 'var(--rust)',
        background: 'rgba(224,103,60,0.15)',
        padding: '2px 8px',
        borderRadius: 999,
      }}
    >
      {parts.join(' · ')}
    </span>
  );
}

const rel = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return d + 'd ago';
};
const ytLink = (r) =>
  'https://www.youtube.com/results?search_query=' +
  encodeURIComponent(`${r.artist} ${r.title} vinyl`);

const USER_LOC = { lat: 52.508, lng: 13.404 };
function distanceKm(a, b) {
  const R = 6371,
    toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat),
    dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ---- auth screen (login / register) ----
function AuthScreen({
  authTab,
  setAuthTab,
  recentEmails,
  onLogin,
  onRegister,
}) {
  const [email, setEmail] = useState((recentEmails && recentEmails[0]) || '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('buyer');
  const [newShop, setNewShop] = useState({ name: '', hood: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [emailFocus, setEmailFocus] = useState(false);

  const isLogin = authTab === 'login';

  const q = email.trim().toLowerCase();
  const suggestions = (recentEmails || [])
    .filter((e) => e !== q && e.includes(q))
    .slice(0, 5);

  const submit = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    const e = isLogin
      ? await onLogin(email, password)
      : await onRegister({
          name,
          email,
          password,
          role,
          newShop: role === 'owner' ? newShop : null,
        });
    setBusy(false);
    if (e) setErr(e);
  };

  return (
    <div
      className="rille"
      style={{
        minHeight: '100dvh',
        background: '#000000',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 393,
          background: 'var(--cream)',
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          padding: '0 22px',
        }}
      >
        <div style={{ textAlign: 'center', paddingTop: 48 }}>
          <Disc size={72} spin />
          <div
            className="serif"
            style={{ fontSize: 26, fontWeight: 600, marginTop: 10 }}
          >
            Crate Digging
          </div>
          <div className="k" style={{ marginTop: 4 }}>
            Find the record, find the shop.
          </div>
        </div>

        <div className="modeseg" style={{ marginTop: 32 }}>
          <button
            className={isLogin ? 'on' : ''}
            onClick={() => {
              setAuthTab('login');
              setErr(null);
            }}
          >
            Log in
          </button>
          <button
            className={!isLogin ? 'on' : ''}
            onClick={() => {
              setAuthTab('register');
              setErr(null);
            }}
          >
            Sign up
          </button>
        </div>

        <div style={{ marginTop: 22 }}>
          {!isLogin && (
            <input
              className="field"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ marginBottom: 10 }}
            />
          )}
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <input
              className="field"
              placeholder="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setEmailFocus(true)}
              onBlur={() => setTimeout(() => setEmailFocus(false), 120)}
            />
            {emailFocus && suggestions.length > 0 && (
              <div className="card" style={{ marginTop: 6 }}>
                {suggestions.map((e, i) => (
                  <div
                    key={e}
                    onMouseDown={() => {
                      setEmail(e);
                      setEmailFocus(false);
                    }}
                    role="button"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '9px 12px',
                      cursor: 'pointer',
                      borderTop: i ? '0.5px solid var(--line)' : 'none',
                      fontSize: 14,
                    }}
                  >
                    <span style={{ color: 'var(--faint)' }}>◷</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {e}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <input
            className="field"
            placeholder="Password"
            type="password"
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {!isLogin && (
            <>
              <div className="k" style={{ margin: '18px 0 6px' }}>
                I'm here to
              </div>
              <div className="seg">
                <div
                  className={'segi' + (role === 'buyer' ? ' on' : '')}
                  onClick={() => setRole('buyer')}
                >
                  Buy records
                </div>
                <div
                  className={'segi' + (role === 'owner' ? ' on' : '')}
                  onClick={() => setRole('owner')}
                >
                  Run a shop
                </div>
              </div>

              {role === 'owner' && (
                <div style={{ marginTop: 14 }}>
                  <div className="k" style={{ marginBottom: 6 }}>
                    Your shop
                  </div>
                  <input
                    className="field"
                    placeholder="Shop name"
                    value={newShop.name}
                    onChange={(e) =>
                      setNewShop({ ...newShop, name: e.target.value })
                    }
                    style={{ marginBottom: 10 }}
                  />
                  <input
                    className="field"
                    placeholder="Neighborhood (e.g. Kreuzberg)"
                    value={newShop.hood}
                    onChange={(e) =>
                      setNewShop({ ...newShop, hood: e.target.value })
                    }
                  />
                </div>
              )}
            </>
          )}

          {err && (
            <div style={{ color: '#E06B6B', fontSize: 13, marginTop: 14 }}>
              {err}
            </div>
          )}

          <button
            className="btn-rust"
            style={{ marginTop: 20, opacity: busy ? 0.6 : 1 }}
            onClick={submit}
          >
            {busy ? 'Please wait…' : isLogin ? 'Log in' : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- add / edit sub-screens ----
function AddRecord({ releases, listings, shopId, onSave, onCancel }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [manual, setManual] = useState(false);
  const [nr, setNr] = useState({ artist: '', title: '', year: '', genre: '' });
  const [cond, setCond] = useState('NM');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState(1);
  const [image, setImage] = useState(null);
  const [dpct, setDpct] = useState('');
  const [doffer, setDoffer] = useState('');

  const alreadyHere = new Set(
    listings.filter((l) => l.shopId === shopId).map((l) => l.releaseId)
  );
  const matches = q.trim()
    ? releases
        .filter((r) =>
          `${r.artist} ${r.title}`.toLowerCase().includes(q.toLowerCase())
        )
        .slice(0, 6)
    : [];

  const pickImage = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      try {
        setImage(await fileToScaledDataURL(file));
      } catch {
        /* ignore */
      }
    }
  };

  const canSave =
    (sel || (nr.artist && nr.title)) && price !== '' && Number(price) >= 0;

  return (
    <div style={{ padding: '4px 18px 24px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 0 14px',
        }}
      >
        <span
          onClick={onCancel}
          role="button"
          style={{ fontSize: 14, color: 'var(--muted)', cursor: 'pointer' }}
        >
          Cancel
        </span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Add record</span>
        <span style={{ width: 44 }} />
      </div>

      {!manual && (
        <>
          <div className="k" style={{ marginBottom: 6 }}>
            Find on Discogs
          </div>
          <input
            className="field"
            placeholder="Artist or title"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(null);
            }}
          />
          {matches.map((r) => (
            <div
              key={r.id}
              onClick={() => {
                setSel(r);
                setQ(`${r.artist} — ${r.title}`);
              }}
              className="row card"
              style={{
                padding: '9px 11px',
                marginTop: 8,
                cursor: 'pointer',
                opacity: sel?.id === r.id ? 1 : 0.95,
              }}
            >
              <Sleeve release={r} size={38} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</div>
                <div className="k">
                  {r.artist} · {r.year} · {r.format}
                </div>
              </div>
              {sel?.id === r.id ? (
                <span style={{ color: '#7FCBA0' }}>✓</span>
              ) : alreadyHere.has(r.id) ? (
                <span className="k" style={{ fontSize: 11 }}>
                  in stock
                </span>
              ) : null}
            </div>
          ))}
          <div
            onClick={() => {
              setManual(true);
              setSel(null);
            }}
            role="button"
            style={{
              fontSize: 13,
              color: 'var(--rust)',
              cursor: 'pointer',
              marginTop: 10,
            }}
          >
            Not on Discogs? Add it by hand
          </div>
        </>
      )}

      {manual && (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span className="k">New release</span>
            <span
              onClick={() => setManual(false)}
              role="button"
              style={{ fontSize: 12, color: 'var(--rust)', cursor: 'pointer' }}
            >
              Search instead
            </span>
          </div>
          <input
            className="field"
            placeholder="Artist"
            value={nr.artist}
            onChange={(e) => setNr({ ...nr, artist: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <input
            className="field"
            placeholder="Title"
            value={nr.title}
            onChange={(e) => setNr({ ...nr, title: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="field"
              placeholder="Year"
              value={nr.year}
              onChange={(e) =>
                setNr({ ...nr, year: e.target.value.replace(/\D/g, '') })
              }
            />
            <input
              className="field"
              placeholder="Genre"
              value={nr.genre}
              onChange={(e) => setNr({ ...nr, genre: e.target.value })}
            />
          </div>
        </>
      )}

      <div className="k" style={{ margin: '18px 0 6px' }}>
        Photo of the record
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 8,
            border: '0.5px solid var(--line)',
            background: image ? 'transparent' : 'var(--card)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {image ? (
            <img
              src={image}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <span style={{ color: 'var(--faint)', fontSize: 20 }}>◒</span>
          )}
        </div>
        <label className="btn-ghost" style={{ cursor: 'pointer' }}>
          {image ? 'Replace photo' : 'Add photo'}
          <input
            type="file"
            accept="image/*"
            onChange={pickImage}
            style={{ display: 'none' }}
          />
        </label>
        {image && (
          <span
            role="button"
            onClick={() => setImage(null)}
            className="k"
            style={{ cursor: 'pointer', color: 'var(--rust)' }}
          >
            Remove
          </span>
        )}
      </div>

      <div className="k" style={{ margin: '18px 0 6px' }}>
        Condition
      </div>
      <div className="seg">
        {CONDITIONS.map((c) => (
          <div
            key={c}
            className={'segi' + (cond === c ? ' on' : '')}
            onClick={() => setCond(c)}
          >
            {c}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>
            Price
          </div>
          <div
            className="field"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span className="k">€</span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))}
              placeholder="28"
              style={{
                border: 'none',
                background: 'transparent',
                outline: 'none',
                width: '100%',
                fontSize: 15,
                color: 'var(--ink)',
              }}
            />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>
            Quantity
          </div>
          <div
            className="field"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              role="button"
              onClick={() => setQty(Math.max(1, qty - 1))}
              style={{ cursor: 'pointer', color: 'var(--muted)' }}
            >
              −
            </span>
            <span style={{ fontWeight: 600 }}>{qty}</span>
            <span
              role="button"
              onClick={() => setQty(qty + 1)}
              style={{ cursor: 'pointer', color: 'var(--muted)' }}
            >
              +
            </span>
          </div>
        </div>
      </div>

      <div className="k" style={{ margin: '16px 0 6px' }}>
        Discount / offer (optional)
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ width: 120 }}>
          <div
            className="field"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <input
              value={dpct}
              onChange={(e) =>
                setDpct(e.target.value.replace(/\D/g, '').slice(0, 2))
              }
              placeholder="0"
              style={{
                border: 'none',
                background: 'transparent',
                outline: 'none',
                width: '100%',
                fontSize: 15,
                color: 'var(--ink)',
              }}
            />
            <span className="k">% off</span>
          </div>
        </div>
        <input
          className="field"
          style={{ flex: 1 }}
          value={doffer}
          onChange={(e) => setDoffer(e.target.value)}
          placeholder="Offer label"
        />
      </div>

      <div
        className="k"
        style={{ margin: '16px 0 14px', display: 'flex', gap: 6 }}
      >
        <span>↻</span>
        <span>
          Records on your Discogs sync are added for you — only hand-add what
          isn't listed online. Everything here is in-store pickup only.
        </span>
      </div>

      <button
        className="btn-rust"
        disabled={!canSave}
        style={{ opacity: canSave ? 1 : 0.5 }}
        onClick={() =>
          onSave({
            release: sel,
            newRelease: manual ? nr : null,
            condition: cond,
            price: Number(price),
            qty,
            image,
            discount:
              Number(dpct) > 0 || doffer.trim()
                ? { pct: Number(dpct) || 0, label: doffer.trim() || undefined }
                : undefined,
          })
        }
      >
        Save to stock
      </button>
    </div>
  );
}

function EditRecord({
  listing,
  release,
  onSave,
  onDelete,
  onCancel,
  onSetImage,
  onSetTracklist,
}) {
  const [cond, setCond] = useState(listing.condition);
  const [price, setPrice] = useState(String(listing.price));
  const [qty, setQty] = useState(listing.qty);
  const [pct, setPct] = useState(
    listing.discount && listing.discount.pct ? String(listing.discount.pct) : ''
  );
  const [offer, setOffer] = useState(
    (listing.discount && listing.discount.label) || ''
  );
  const [sides, setSides] = useState(() =>
    release.tracklist && release.tracklist.length
      ? release.tracklist.map((s) => ({
          label: s.label,
          tracks: [...s.tracks],
        }))
      : [
          { label: 'A', tracks: [''] },
          { label: 'B', tracks: [''] },
        ]
  );

  const setTrack = (si, ti, v) =>
    setSides(
      sides.map((s, i) =>
        i === si
          ? { ...s, tracks: s.tracks.map((t, j) => (j === ti ? v : t)) }
          : s
      )
    );
  const addTrack = (si) =>
    setSides(
      sides.map((s, i) => (i === si ? { ...s, tracks: [...s.tracks, ''] } : s))
    );
  const removeTrack = (si, ti) =>
    setSides(
      sides.map((s, i) =>
        i === si ? { ...s, tracks: s.tracks.filter((_, j) => j !== ti) } : s
      )
    );
  const addSide = () =>
    setSides([
      ...sides,
      { label: String.fromCharCode(65 + sides.length), tracks: [''] },
    ]);
  const removeSide = (si) => setSides(sides.filter((_, i) => i !== si));

  const pickImage = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      try {
        onSetImage(release.id, await fileToScaledDataURL(file));
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <div style={{ padding: '4px 18px 24px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 0 14px',
        }}
      >
        <span
          onClick={onCancel}
          role="button"
          style={{ fontSize: 14, color: 'var(--muted)', cursor: 'pointer' }}
        >
          Cancel
        </span>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Edit record</span>
        <span style={{ width: 44 }} />
      </div>

      <div className="row card" style={{ padding: '10px 12px' }}>
        <Sleeve release={release} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{release.title}</div>
          <div className="k">
            {release.artist} · {release.year}
          </div>
        </div>
        <SourceBadge source={listing.source} />
      </div>

      <div className="k" style={{ margin: '18px 0 6px' }}>
        Photo of the record
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 8,
            border: '0.5px solid var(--line)',
            overflow: 'hidden',
            flexShrink: 0,
            background: 'var(--card)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {release.image ? (
            <img
              src={release.image}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <span style={{ color: 'var(--faint)', fontSize: 20 }}>◒</span>
          )}
        </div>
        <label className="btn-ghost" style={{ cursor: 'pointer' }}>
          {release.image ? 'Replace photo' : 'Add photo'}
          <input
            type="file"
            accept="image/*"
            onChange={pickImage}
            style={{ display: 'none' }}
          />
        </label>
        {release.image && (
          <span
            role="button"
            onClick={() => onSetImage(release.id, null)}
            className="k"
            style={{ cursor: 'pointer', color: 'var(--rust)' }}
          >
            Remove
          </span>
        )}
      </div>

      <div className="k" style={{ margin: '18px 0 6px' }}>
        Condition
      </div>
      <div className="seg">
        {CONDITIONS.map((c) => (
          <div
            key={c}
            className={'segi' + (cond === c ? ' on' : '')}
            onClick={() => setCond(c)}
          >
            {c}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>
            Price
          </div>
          <div
            className="field"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span className="k">€</span>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))}
              style={{
                border: 'none',
                background: 'transparent',
                outline: 'none',
                width: '100%',
                fontSize: 15,
                color: 'var(--ink)',
              }}
            />
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="k" style={{ marginBottom: 6 }}>
            Quantity
          </div>
          <div
            className="field"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              role="button"
              onClick={() => setQty(Math.max(0, qty - 1))}
              style={{ cursor: 'pointer', color: 'var(--muted)' }}
            >
              −
            </span>
            <span style={{ fontWeight: 600 }}>{qty}</span>
            <span
              role="button"
              onClick={() => setQty(qty + 1)}
              style={{ cursor: 'pointer', color: 'var(--muted)' }}
            >
              +
            </span>
          </div>
        </div>
      </div>

      <div
        className="k"
        style={{
          margin: '18px 0 6px',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Discount / offer</span>
        {pct || offer ? (
          <span
            role="button"
            onClick={() => {
              setPct('');
              setOffer('');
            }}
            style={{ color: 'var(--rust)', cursor: 'pointer' }}
          >
            Remove
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ width: 120 }}>
          <div
            className="field"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <input
              value={pct}
              onChange={(e) =>
                setPct(e.target.value.replace(/\D/g, '').slice(0, 2))
              }
              placeholder="0"
              style={{
                border: 'none',
                background: 'transparent',
                outline: 'none',
                width: '100%',
                fontSize: 15,
                color: 'var(--ink)',
              }}
            />
            <span className="k">% off</span>
          </div>
        </div>
        <input
          className="field"
          style={{ flex: 1 }}
          value={offer}
          onChange={(e) => setOffer(e.target.value)}
          placeholder="Offer label (optional)"
        />
      </div>
      {Number(pct) > 0 && (
        <div className="k" style={{ fontSize: 12, marginTop: 6 }}>
          Buyers pay €
          {Math.round((Number(price) || 0) * (1 - Number(pct) / 100))} instead
          of €{Number(price) || 0}
        </div>
      )}

      <div className="k" style={{ margin: '18px 0 8px' }}>
        Tracklist
      </div>
      {sides.map((side, si) => (
        <div key={si} style={{ marginBottom: 12 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Side {side.label}
            </span>
            {sides.length > 1 ? (
              <span
                role="button"
                onClick={() => removeSide(si)}
                className="k"
                style={{ color: 'var(--rust)', cursor: 'pointer' }}
              >
                Remove side
              </span>
            ) : null}
          </div>
          {side.tracks.map((t, ti) => (
            <div
              key={ti}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 6,
              }}
            >
              <span className="k" style={{ width: 14, flexShrink: 0 }}>
                {ti + 1}
              </span>
              <input
                className="field"
                style={{ flex: 1 }}
                value={t}
                onChange={(e) => setTrack(si, ti, e.target.value)}
                placeholder="Song title"
              />
              {side.tracks.length > 1 ? (
                <span
                  role="button"
                  onClick={() => removeTrack(si, ti)}
                  style={{
                    cursor: 'pointer',
                    color: 'var(--faint)',
                    fontSize: 18,
                    width: 16,
                    textAlign: 'center',
                  }}
                >
                  ×
                </span>
              ) : null}
            </div>
          ))}
          <span
            role="button"
            onClick={() => addTrack(si)}
            style={{ fontSize: 13, color: 'var(--rust)', cursor: 'pointer' }}
          >
            + Add song
          </span>
        </div>
      ))}
      <span
        role="button"
        onClick={addSide}
        className="btn-ghost"
        style={{ display: 'inline-block', cursor: 'pointer' }}
      >
        + Add side
      </span>

      <button
        className="btn-rust"
        style={{ marginTop: 20 }}
        onClick={() => {
          onSetTracklist(release.id, sides);
          onSave({
            ...listing,
            condition: cond,
            price: Number(price) || 0,
            qty,
            discount:
              Number(pct) > 0 || offer.trim()
                ? { pct: Number(pct) || 0, label: offer.trim() || undefined }
                : undefined,
            updated: new Date().toISOString(),
          });
        }}
      >
        Save changes
      </button>
      <button
        className="btn-ghost"
        style={{
          width: '100%',
          marginTop: 10,
          color: '#E06B6B',
          borderColor: '#402626',
        }}
        onClick={() => onDelete(listing.id)}
      >
        Remove from stock
      </button>
    </div>
  );
}

// ---- root ----
export default function App() {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState({ shops: [], releases: [] });
  const [listings, setListings] = useState([]);
  const [reservations, setReservations] = useState([]);

  const [mode, setMode] = useState('buyer'); // buyer | owner  (owner can toggle to shop)
  const [currentUser, setCurrentUser] = useState(null);
  const [authTab, setAuthTab] = useState('login');
  const [recentEmails, setRecentEmails] = useState([]);
  const [bScreen, setBScreen] = useState({ name: 'search' });
  const [oScreen, setOScreen] = useState({ name: 'stock' });
  const [query, setQuery] = useState('');
  const [stockFilter, setStockFilter] = useState('all');
  const [stockQuery, setStockQuery] = useState('');
  const [toast, setToast] = useState(null);

  const shopById = useMemo(
    () => Object.fromEntries(catalog.shops.map((s) => [s.id, s])),
    [catalog.shops]
  );
  const relById = useMemo(
    () => Object.fromEntries(catalog.releases.map((r) => [r.id, r])),
    [catalog.releases]
  );

  // ---- Supabase loaders ----
  const loadCatalog = async () => {
    const [shopsRes, relRes] = await Promise.all([
      supabase.from('shops').select('*'),
      supabase.from('releases').select('*'),
    ]);
    if (shopsRes.error) console.error('shops load:', shopsRes.error.message);
    if (relRes.error) console.error('releases load:', relRes.error.message);
    setCatalog({
      shops: (shopsRes.data || []).map(mapShop),
      releases: (relRes.data || []).map(mapRelease),
    });
  };
  const loadListings = async () => {
    const { data, error } = await supabase.from('listings').select('*');
    if (error) console.error('listings load:', error.message);
    setListings((data || []).map(mapListing));
  };
  const loadReservations = async () => {
    const { data, error } = await supabase.from('reservations').select('*');
    if (error) console.error('reservations load:', error.message);
    setReservations((data || []).map(mapReservation));
  };
  const loadAll = async () => {
    await Promise.all([loadCatalog(), loadListings(), loadReservations()]);
  };

  const loadProfile = async (userId, email) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (error) console.error('profile load:', error.message);
    if (data)
      setCurrentUser({
        id: data.id,
        name: data.name,
        role: data.role,
        shopId: data.shop_id,
        saved: data.saved || [],
        email,
      });
    else setCurrentUser(null);
    return data;
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session && session.user)
        await loadProfile(session.user.id, session.user.email);
      await loadAll();
      setRecentEmails(getRecentEmails());
      if (mounted) setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        if (session && session.user) {
          await loadProfile(session.user.id, session.user.email);
          await loadAll();
        } else {
          setCurrentUser(null);
        }
      }
    );
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (m) => {
    setToast(m);
    setTimeout(() => setToast(null), 1800);
  };

  const rememberEmail = (email) => {
    const em = (email || '').trim().toLowerCase();
    if (!em) return;
    const next = [em, ...recentEmails.filter((e) => e !== em)].slice(0, 5);
    setRecentEmails(next);
    putRecentEmails(next);
  };

  // ---- auth ----
  const login = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: (email || '').trim(),
      password,
    });
    if (error)
      return /invalid/i.test(error.message)
        ? 'Wrong email or password.'
        : error.message;
    rememberEmail(email);
    setMode('buyer');
    setBScreen({ name: 'search' });
    setOScreen({ name: 'stock' });
    return null; // profile + data load via onAuthStateChange
  };

  const register = async ({ name, email, password, role, newShop }) => {
    const em = (email || '').trim();
    if (!name.trim() || !em || !password)
      return 'Fill in your name, email, and password.';
    if (password.length < 6) return 'Password must be at least 6 characters.';
    if (role === 'owner' && !(newShop && newShop.name.trim()))
      return 'Enter your shop name.';
    const { data, error } = await supabase.auth.signUp({ email: em, password });
    if (error)
      return /registered|exists/i.test(error.message)
        ? 'That email is already registered.'
        : error.message;
    const user = data.user;
    if (!user)
      return 'Could not create the account — check the email confirmation setting in Supabase.';
    let shopId = null;
    if (role === 'owner') {
      const { data: shop, error: se } = await supabase
        .from('shops')
        .insert({
          owner_id: user.id,
          name: newShop.name.trim(),
          hood: (newShop.hood || '').trim() || 'Berlin',
          lat: 52.505 + (Math.random() - 0.5) * 0.06,
          lng: 13.4 + (Math.random() - 0.5) * 0.08,
        })
        .select()
        .single();
      if (se)
        return "Account made, but the shop couldn't be created: " + se.message;
      shopId = shop.id;
    }
    const { error: pe } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        name: name.trim(),
        role,
        shop_id: shopId,
        saved: [],
      });
    if (pe)
      return "Account made, but the profile couldn't be saved: " + pe.message;
    rememberEmail(em);
    await loadProfile(user.id, em);
    await loadAll();
    setMode('buyer');
    setBScreen({ name: 'search' });
    setOScreen({ name: 'stock' });
    return null;
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setCurrentUser(null);
    setMode('buyer');
  };

  // ---- buyer actions ----
  const toggleSave = async (releaseId) => {
    if (!currentUser) return;
    const cur = currentUser.saved || [];
    const next = cur.includes(releaseId)
      ? cur.filter((x) => x !== releaseId)
      : [...cur, releaseId];
    setCurrentUser({ ...currentUser, saved: next });
    const { error } = await supabase
      .from('profiles')
      .update({ saved: next })
      .eq('id', currentUser.id);
    if (error) console.error('save toggle:', error.message);
  };

  const reserve = async (l) => {
    const { error } = await supabase.rpc('request_reservation', {
      p_listing: l.id,
    });
    if (error) {
      flash(
        /spoken/i.test(error.message)
          ? 'Just got reserved by someone else'
          : "Couldn't reserve"
      );
      await loadListings();
      return;
    }
    await Promise.all([loadListings(), loadReservations()]);
    flash('Request sent — waiting for the shop');
  };

  // ---- owner actions ----
  const setListingStatus = async (id, status) => {
    const { error } = await supabase
      .from('listings')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      flash("Couldn't update");
      console.error(error.message);
    }
    await loadListings();
  };

  const saveEdit = async (u) => {
    const { error } = await supabase
      .from('listings')
      .update({
        condition: u.condition,
        price: u.price,
        qty: u.qty,
        discount: u.discount || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', u.id);
    if (error) {
      flash("Couldn't save");
      console.error(error.message);
      return;
    }
    await loadListings();
    setOScreen({ name: 'stock' });
    flash('Changes saved');
  };

  const deleteListing = async (id) => {
    const { error } = await supabase.from('listings').delete().eq('id', id);
    if (error) {
      flash("Couldn't remove");
      console.error(error.message);
      return;
    }
    await loadListings();
    setOScreen({ name: 'stock' });
    flash('Removed');
  };

  const setReleaseImage = async (releaseId, dataUrl) => {
    const { error } = await supabase
      .from('releases')
      .update({ image: dataUrl || null })
      .eq('id', releaseId);
    if (error) console.error('image save:', error.message);
    await loadCatalog();
  };

  const setReleaseTracklist = async (releaseId, sides) => {
    const clean = sides
      .map((s) => ({
        label: s.label,
        tracks: s.tracks.map((t) => t.trim()).filter(Boolean),
      }))
      .filter((s) => s.tracks.length);
    const { error } = await supabase
      .from('releases')
      .update({ tracklist: clean.length ? clean : null })
      .eq('id', releaseId);
    if (error) console.error('tracklist save:', error.message);
    await loadCatalog();
  };

  const addRecord = async ({
    release,
    newRelease,
    condition,
    price,
    qty,
    image,
    discount,
  }) => {
    if (!currentUser || !currentUser.shopId) {
      flash('No shop linked to your account');
      return;
    }
    let releaseId;
    if (newRelease) {
      const palette = [
        ['#2C3A2E', '#D8763A'],
        ['#33283F', '#6FA5A0'],
        ['#3B2C22', '#E09A3C'],
        ['#20242E', '#5DCAA5'],
      ];
      const { data: rel, error } = await supabase
        .from('releases')
        .insert({
          artist: newRelease.artist,
          title: newRelease.title,
          year: Number(newRelease.year) || null,
          genre: newRelease.genre || '',
          format: 'LP',
          cover: palette[Math.floor(Math.random() * palette.length)],
          image: image || null,
        })
        .select()
        .single();
      if (error) {
        flash("Couldn't add the record");
        console.error(error.message);
        return;
      }
      releaseId = rel.id;
    } else {
      releaseId = release.id;
      if (image)
        await supabase.from('releases').update({ image }).eq('id', releaseId);
    }
    const { error: le } = await supabase.from('listings').insert({
      shop_id: currentUser.shopId,
      release_id: releaseId,
      condition,
      price,
      qty,
      discount: discount || null,
      status: 'available',
      source: 'manual',
    });
    if (le) {
      flash("Couldn't add to stock");
      console.error(le.message);
      return;
    }
    await Promise.all([loadCatalog(), loadListings()]);
    setOScreen({ name: 'stock' });
    flash('Added to stock');
  };

  // ---- reservation approval ----
  const acceptReservation = async (res) => {
    await supabase
      .from('listings')
      .update({ status: 'reserved', updated_at: new Date().toISOString() })
      .eq('id', res.listingId);
    await supabase
      .from('reservations')
      .update({ status: 'held' })
      .eq('id', res.id);
    await Promise.all([loadListings(), loadReservations()]);
    flash('Reservation accepted');
  };
  const declineReservation = async (res) => {
    await supabase
      .from('listings')
      .update({ status: 'available', updated_at: new Date().toISOString() })
      .eq('id', res.listingId);
    await supabase
      .from('reservations')
      .update({ status: 'cancelled' })
      .eq('id', res.id);
    await Promise.all([loadListings(), loadReservations()]);
    flash('Request declined');
  };
  const markPickedUp = async (res) => {
    await supabase
      .from('listings')
      .update({ status: 'sold', updated_at: new Date().toISOString() })
      .eq('id', res.listingId);
    await supabase
      .from('reservations')
      .update({ status: 'picked_up' })
      .eq('id', res.id);
    await Promise.all([loadListings(), loadReservations()]);
    flash('Marked picked up');
  };
  const cancelReservation = async (res) => {
    await supabase
      .from('listings')
      .update({ status: 'available', updated_at: new Date().toISOString() })
      .eq('id', res.listingId);
    await supabase
      .from('reservations')
      .update({ status: 'cancelled' })
      .eq('id', res.id);
    await Promise.all([loadListings(), loadReservations()]);
    flash('Reservation released');
  };

  // ---- derived views ----
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    const score = (r) => {
      if (!q) return 0;
      const artist = r.artist.toLowerCase();
      const title = r.title.toLowerCase();
      const genre = (r.genre || '').toLowerCase();
      if (title.startsWith(q) || artist.startsWith(q)) return 0; // starts with the query
      if ((artist + ' ' + title).split(/\s+/).some((w) => w.startsWith(q)))
        return 1; // a word starts with it
      if (title.includes(q) || artist.includes(q)) return 2; // appears somewhere
      if (genre.includes(q)) return 3; // genre match
      return -1; // no match
    };
    return catalog.releases
      .map((r) => {
        const avail = listings.filter(
          (l) => l.releaseId === r.id && l.status === 'available'
        );
        return {
          release: r,
          shops: avail.length,
          min: avail.length ? Math.min(...avail.map(effPrice)) : null,
          s: score(r),
        };
      })
      .filter((x) => x.shops > 0 && x.s >= 0)
      .sort(
        (a, b) => a.s - b.s || a.release.title.localeCompare(b.release.title)
      );
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
      @media (prefers-reduced-motion:reduce){.spin{animation:none}}
      .modeseg{display:flex;background:var(--panel);border-radius:999px;padding:3px}
      .modeseg button{flex:1;border:none;background:transparent;border-radius:999px;padding:6px 10px;font-size:13px;color:var(--muted);cursor:pointer}
      .modeseg button.on{background:var(--rust);color:var(--cream);font-weight:600}
      .scroll{overflow-y:auto;flex:1}
      .scroll::-webkit-scrollbar{width:0}
    `}</style>
  );

  if (loading) {
    return (
      <div
        className="rille"
        style={{
          minHeight: '100dvh',
          background: '#000000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {styleTag}
        <div style={{ color: '#F2F2F2', textAlign: 'center' }}>
          <Disc size={64} spin />
          <div className="serif" style={{ marginTop: 12, fontSize: 18 }}>
            Crate Digging
          </div>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        {styleTag}
        <AuthScreen
          authTab={authTab}
          setAuthTab={setAuthTab}
          recentEmails={recentEmails}
          onLogin={login}
          onRegister={register}
        />
      </>
    );
  }

  const isOwner = currentUser.role === 'owner';
  const saved = currentUser.saved || [];
  const savedSet = new Set(saved);

  // ---- buyer screens ----
  const RecordRow = ({ r, shops, min }) => (
    <div
      className="row card"
      style={{ padding: '10px 12px', marginBottom: 8, cursor: 'pointer' }}
      onClick={() => setBScreen({ name: 'detail', releaseId: r.id })}
    >
      <Sleeve release={r} size={52} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="serif"
          style={{
            fontSize: 16,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {r.title}
        </div>
        <div className="k">
          {r.artist} · {r.year}
        </div>
        <div className="k" style={{ marginTop: 3 }}>
          {shops} shop{shops > 1 ? 's' : ''} · in-store only
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div className="k">from</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--rust)' }}>
          €{min}
        </div>
      </div>
    </div>
  );

  const BuyerSearch = () => (
    <div style={{ padding: '6px 18px 20px' }}>
      <div
        className="row card"
        style={{ padding: '10px 12px', marginBottom: 14 }}
      >
        <span style={{ color: 'var(--muted)' }}>⌕</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search artist or title"
          style={{
            border: 'none',
            background: 'transparent',
            outline: 'none',
            width: '100%',
            fontSize: 15,
            color: 'var(--ink)',
          }}
        />
      </div>
      {searchResults.length === 0 ? (
        <div
          className="k"
          style={{ textAlign: 'center', padding: '40px 20px' }}
        >
          No records match that. Try another artist or title.
        </div>
      ) : (
        searchResults.map((x) => (
          <RecordRow
            key={x.release.id}
            r={x.release}
            shops={x.shops}
            min={x.min}
          />
        ))
      )}
    </div>
  );

  const BuyerDetail = () => {
    const r = relById[bScreen.releaseId];
    if (!r) return null;
    const rows = listings.filter(
      (l) => l.releaseId === r.id && l.status !== 'sold'
    );
    const isSaved = savedSet.has(r.id);
    return (
      <div className="scroll">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '8px 16px 0',
          }}
        >
          <span
            role="button"
            onClick={() => setBScreen({ name: 'search' })}
            style={{ fontSize: 22, cursor: 'pointer' }}
          >
            ‹
          </span>
          <span
            role="button"
            onClick={() => toggleSave(r.id)}
            style={{
              fontSize: 20,
              cursor: 'pointer',
              color: isSaved ? 'var(--rust)' : 'var(--faint)',
            }}
          >
            {isSaved ? '♥' : '♡'}
          </span>
        </div>
        <div
          style={{ position: 'relative', height: 170, margin: '4px 18px 0' }}
        >
          <div style={{ position: 'absolute', right: 18, top: 12 }}>
            <Disc size={140} label={r.cover[1]} spin />
          </div>
          <div style={{ position: 'absolute', left: 0, top: 6 }}>
            <Sleeve release={r} size={150} />
          </div>
        </div>
        <div style={{ padding: '6px 20px 0' }}>
          <div
            style={{
              fontSize: 12,
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--muted)',
            }}
          >
            {r.artist}
          </div>
          <div
            className="serif"
            style={{
              fontSize: 24,
              fontWeight: 600,
              lineHeight: 1.2,
              marginTop: 2,
            }}
          >
            {r.title}
          </div>
          <div className="k" style={{ marginTop: 4 }}>
            {r.year} · {r.format} · {r.genre}
          </div>
        </div>
        <a
          href={ytLink(r)}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none' }}
        >
          <div
            className="row card"
            style={{ margin: '12px 16px 0', padding: '10px 12px' }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: '50%',
                background: 'var(--rust)',
                color: 'var(--cream)',
                flexShrink: 0,
              }}
            >
              ▶
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                Preview on YouTube
              </div>
              <div className="k">opens outside the app</div>
            </div>
            <span className="k">↗</span>
          </div>
        </a>
        {r.tracklist && r.tracklist.length > 0 && (
          <div style={{ padding: '18px 20px 0' }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              Tracklist
            </div>
            {r.tracklist.map((side, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div
                  className="k"
                  style={{
                    fontSize: 11,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    marginBottom: 4,
                  }}
                >
                  Side {side.label}
                </div>
                {side.tracks.map((t, j) => (
                  <div
                    key={j}
                    style={{
                      display: 'flex',
                      gap: 10,
                      fontSize: 14,
                      padding: '3px 0',
                    }}
                  >
                    <span className="k" style={{ width: 16, flexShrink: 0 }}>
                      {j + 1}
                    </span>
                    <span>{t}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            padding: '18px 20px 8px',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600 }}>
            Available in Berlin
          </span>
          <span className="k">
            {rows.filter((l) => l.status === 'available').length} shops
          </span>
        </div>
        <div style={{ padding: '0 16px 24px' }}>
          {rows.map((l) => {
            const s = shopById[l.shopId];
            return (
              <div
                key={l.id}
                className="row card"
                style={{
                  padding: '11px 13px',
                  marginBottom: 8,
                  alignItems: 'flex-start',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</div>
                  <div className="k">
                    {s.hood} · {s.address}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                    }}
                  >
                    <span
                      className="k"
                      style={{
                        fontSize: 11,
                        background: '#1E1E1E',
                        color: '#9A9A9A',
                        padding: '2px 7px',
                        borderRadius: 999,
                      }}
                    >
                      {l.condition}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: '#E0955F',
                        background: '#2A1D14',
                        padding: '2px 8px',
                        borderRadius: 999,
                      }}
                    >
                      In-store only
                    </span>
                    <DiscountBadge listing={l} />
                  </div>
                  <div className="k" style={{ fontSize: 11, marginTop: 5 }}>
                    updated {rel(l.updated)}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <PriceTag listing={l} size={16} />
                  {l.status === 'available' ? (
                    <button
                      className="btn-ghost"
                      style={{
                        marginTop: 8,
                        padding: '7px 12px',
                        fontSize: 12,
                      }}
                      onClick={() => reserve(l)}
                    >
                      Reserve
                    </button>
                  ) : (
                    <div style={{ marginTop: 10 }}>
                      <StatusPill status={l.status} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div
            className="k"
            style={{ fontSize: 11, textAlign: 'center', marginTop: 6 }}
          >
            Reserving holds a copy — pickup and payment happen in the shop.
          </div>
        </div>
      </div>
    );
  };

  const BuyerSaved = () => {
    const items = saved.map((id) => relById[id]).filter(Boolean);
    return (
      <div style={{ padding: '10px 18px 20px' }}>
        {items.length === 0 ? (
          <div
            className="k"
            style={{ textAlign: 'center', padding: '40px 20px' }}
          >
            Nothing saved yet. Tap the heart on a record to keep it here.
          </div>
        ) : (
          items.map((r) => {
            const avail = listings.filter(
              (l) => l.releaseId === r.id && l.status === 'available'
            );
            return (
              <RecordRow
                key={r.id}
                r={r}
                shops={avail.length}
                min={avail.length ? Math.min(...avail.map(effPrice)) : '—'}
              />
            );
          })
        )}
      </div>
    );
  };

  const BuyerReserved = () => {
    const held = reservations.filter(
      (r) =>
        (r.status === 'held' || r.status === 'pending') &&
        r.buyerId === currentUser.id
    );
    return (
      <div style={{ padding: '10px 18px 20px' }}>
        {held.length === 0 ? (
          <div
            className="k"
            style={{ textAlign: 'center', padding: '40px 20px' }}
          >
            No reservations yet. Reserve a record and pick it up in store.
          </div>
        ) : (
          held.map((res) => {
            const r = relById[res.releaseId];
            const s = shopById[res.shopId];
            return (
              <div
                key={res.id}
                className="row card"
                style={{ padding: '11px 13px', marginBottom: 8 }}
              >
                <Sleeve release={r} size={46} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="serif"
                    style={{ fontSize: 15, fontWeight: 600 }}
                  >
                    {r.title}
                  </div>
                  <div className="k">
                    {s.name} · {s.hood}
                  </div>
                  <div className="k" style={{ fontSize: 11, marginTop: 3 }}>
                    {res.status === 'pending'
                      ? 'waiting for the shop to accept'
                      : 'ready to pick up in store'}
                  </div>
                </div>
                <StatusPill
                  status={res.status === 'pending' ? 'pending' : 'reserved'}
                />
              </div>
            );
          })
        )}
      </div>
    );
  };

  // ---- stores + shop (buyer) ----
  const shopStock = (id) =>
    listings.filter((l) => l.shopId === id && l.status === 'available').length;
  const gmapsUrl = (s) =>
    typeof s.lat === 'number'
      ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${s.name} ${s.hood || ''} Berlin`
        )}`;

  const StoresScreen = () => {
    const shops = catalog.shops
      .filter((s) => listings.some((l) => l.shopId === s.id)) // only shops actually selling on the app
      .map((s) => ({
        s,
        d: typeof s.lat === 'number' ? distanceKm(USER_LOC, s) : null,
        n: shopStock(s.id),
      }))
      .sort((a, b) => (a.d == null ? 999 : a.d) - (b.d == null ? 999 : b.d));
    return (
      <div style={{ padding: '6px 18px 20px' }}>
        <div style={{ fontSize: 22, fontWeight: 600, margin: '6px 0 2px' }}>
          Stores
        </div>
        <div className="k" style={{ marginBottom: 14 }}>
          Record shops selling on Crate Digging
        </div>
        {shops.length === 0 ? (
          <div
            className="k"
            style={{ textAlign: 'center', padding: '40px 20px' }}
          >
            No shops are selling yet.
          </div>
        ) : (
          shops.map(({ s, d, n }) => (
            <div
              key={s.id}
              className="card"
              style={{ padding: '12px 13px', marginBottom: 8 }}
            >
              <div
                className="row"
                style={{ cursor: 'pointer' }}
                onClick={() => setBScreen({ name: 'shop', shopId: s.id })}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 36,
                    height: 36,
                    borderRadius: 999,
                    background: 'var(--rust)',
                    color: 'var(--cream)',
                    flexShrink: 0,
                  }}
                >
                  ◉
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{s.name}</div>
                  <div className="k">
                    {s.hood}
                    {s.address ? ' · ' + s.address : ''}
                  </div>
                  {d != null ? (
                    <div className="k" style={{ fontSize: 11, marginTop: 2 }}>
                      {d.toFixed(1)} km away
                    </div>
                  ) : null}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: 'var(--rust)',
                    }}
                  >
                    {n}
                  </div>
                  <div className="k" style={{ fontSize: 11 }}>
                    in stock
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 18,
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: '0.5px solid var(--line)',
                }}
              >
                <span
                  role="button"
                  onClick={() => setBScreen({ name: 'shop', shopId: s.id })}
                  style={{
                    fontSize: 13,
                    color: 'var(--rust)',
                    cursor: 'pointer',
                  }}
                >
                  View records
                </span>
                <a
                  href={gmapsUrl(s)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 13,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                  }}
                >
                  Open in Google Maps ↗
                </a>
              </div>
            </div>
          ))
        )}
      </div>
    );
  };

  const ShopScreen = () => {
    const s = shopById[bScreen.shopId];
    if (!s) return null;
    const recs = listings.filter(
      (l) => l.shopId === s.id && l.status !== 'sold'
    );
    const availCount = recs.filter((l) => l.status === 'available').length;
    return (
      <div className="scroll">
        <div style={{ padding: '8px 16px 0' }}>
          <span
            role="button"
            onClick={() => setBScreen({ name: 'stores' })}
            style={{ fontSize: 22, cursor: 'pointer' }}
          >
            ‹
          </span>
        </div>
        <div style={{ padding: '4px 20px 0' }}>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{s.name}</div>
          <div className="k" style={{ marginTop: 5 }}>
            {s.hood}
            {s.address ? ' · ' + s.address : ''}
            {typeof s.lat === 'number'
              ? ' · ' + distanceKm(USER_LOC, s).toFixed(1) + ' km away'
              : ''}
          </div>
          <div className="k" style={{ marginTop: 2 }}>
            {availCount} record{availCount === 1 ? '' : 's'} available ·
            in-store pickup only
          </div>
          <a
            href={gmapsUrl(s)}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              marginTop: 10,
              fontSize: 13,
              color: 'var(--rust)',
              textDecoration: 'none',
            }}
          >
            Open in Google Maps ↗
          </a>
        </div>
        <div style={{ padding: '16px 16px 24px' }}>
          {recs.length === 0 ? (
            <div
              className="k"
              style={{ textAlign: 'center', padding: '34px 20px' }}
            >
              This shop hasn't listed any records yet.
            </div>
          ) : (
            recs.map((l) => {
              const r = relById[l.releaseId];
              return (
                <div
                  key={l.id}
                  className="row card"
                  style={{
                    padding: '10px 12px',
                    marginBottom: 8,
                    alignItems: 'flex-start',
                  }}
                >
                  <Sleeve release={r} size={48} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {r.title}
                    </div>
                    <div className="k">
                      {r.artist} · {r.year} · {l.condition}
                    </div>
                    {l.discount ? (
                      <div style={{ marginTop: 5 }}>
                        <DiscountBadge listing={l} />
                      </div>
                    ) : null}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <PriceTag listing={l} size={15} />
                    {l.status === 'available' ? (
                      <button
                        className="btn-ghost"
                        style={{
                          marginTop: 8,
                          padding: '7px 12px',
                          fontSize: 12,
                        }}
                        onClick={() => reserve(l)}
                      >
                        Reserve
                      </button>
                    ) : (
                      <div style={{ marginTop: 10 }}>
                        <StatusPill status={l.status} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };

  // ---- owner screens ----
  const myShopId = currentUser.shopId;
  const myListings = listings.filter((l) => l.shopId === myShopId);
  const myShop = shopById[myShopId];

  const OwnerStock = () => (
    <div style={{ padding: '6px 18px 20px' }}>
      <div
        className="card"
        style={{
          padding: '10px 13px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 8,
            background: 'var(--rust)',
            color: 'var(--cream)',
            flexShrink: 0,
          }}
        >
          ◉
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {myShop ? myShop.name : 'Your shop'}
          </div>
          <div className="k">
            {myShop ? myShop.hood : ''} · you're the owner
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div
          style={{
            background: '#151515',
            borderRadius: 10,
            padding: '10px 12px',
          }}
        >
          <div className="k">In stock</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            {myListings.filter((l) => l.status === 'available').length}
          </div>
        </div>
        <div
          style={{
            background: '#151515',
            borderRadius: 10,
            padding: '10px 12px',
          }}
        >
          <div className="k">Reserved</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            {myListings.filter((l) => l.status === 'reserved').length}
          </div>
        </div>
      </div>
      <div className="k" style={{ fontSize: 11, marginTop: 6 }}>
        {myListings.filter((l) => l.source === 'discogs').length} of these sync
        automatically from Discogs
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          margin: '16px 0 10px',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600 }}>Your records</span>
        <button
          className="btn-rust"
          style={{ width: 'auto', padding: '7px 14px', fontSize: 13 }}
          onClick={() => setOScreen({ name: 'add' })}
        >
          + Add
        </button>
      </div>

      <div
        className="row card"
        style={{ padding: '9px 12px', marginBottom: 10 }}
      >
        <span style={{ color: 'var(--muted)' }}>⌕</span>
        <input
          value={stockQuery}
          onChange={(e) => setStockQuery(e.target.value)}
          placeholder="Search your stock"
          style={{
            border: 'none',
            background: 'transparent',
            outline: 'none',
            width: '100%',
            fontSize: 15,
            color: 'var(--ink)',
          }}
        />
      </div>

      <div
        style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto' }}
      >
        {[
          ['all', 'All'],
          ['available', 'Available'],
          ['pending', 'Pending'],
          ['reserved', 'Reserved'],
          ['sold', 'Sold'],
        ].map(([key, label]) => (
          <span
            key={key}
            onClick={() => setStockFilter(key)}
            role="button"
            style={{
              fontSize: 12,
              padding: '6px 12px',
              borderRadius: 999,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              background: stockFilter === key ? 'var(--rust)' : 'var(--card)',
              color: stockFilter === key ? 'var(--cream)' : 'var(--muted)',
              border:
                '0.5px solid ' +
                (stockFilter === key ? 'var(--rust)' : 'var(--line)'),
              fontWeight: stockFilter === key ? 600 : 400,
            }}
          >
            {label}
          </span>
        ))}
      </div>

      {(() => {
        const q = stockQuery.trim().toLowerCase();
        const shown = myListings.filter((l) => {
          if (stockFilter !== 'all' && l.status !== stockFilter) return false;
          if (!q) return true;
          const r = relById[l.releaseId];
          return `${r?.artist} ${r?.title}`.toLowerCase().includes(q);
        });
        if (myListings.length === 0)
          return (
            <div
              className="k"
              style={{ textAlign: 'center', padding: '30px 20px' }}
            >
              No records yet. Add your first one.
            </div>
          );
        if (shown.length === 0)
          return (
            <div
              className="k"
              style={{ textAlign: 'center', padding: '30px 20px' }}
            >
              Nothing matches that filter.
            </div>
          );
        return shown.map((l) => {
          const r = relById[l.releaseId];
          return (
            <div
              key={l.id}
              className="row card"
              style={{ padding: '10px 12px', marginBottom: 8 }}
            >
              <Sleeve release={r} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.title}
                </div>
                <div className="k">
                  {r.artist} · {l.condition}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <SourceBadge source={l.source} />
                  <DiscountBadge listing={l} />
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <PriceTag listing={l} size={15} />
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    marginTop: 6,
                  }}
                >
                  {l.status === 'pending' ? (
                    <StatusPill status="pending" />
                  ) : (
                    <select
                      value={l.status}
                      onChange={(e) => setListingStatus(l.id, e.target.value)}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        background: STATUS_COLORS[l.status].bg,
                        color: STATUS_COLORS[l.status].fg,
                        border: 'none',
                        borderRadius: 999,
                        padding: '3px 6px',
                        cursor: 'pointer',
                      }}
                    >
                      <option value="available">Available</option>
                      <option value="reserved">Reserved</option>
                      <option value="sold">Sold</option>
                    </select>
                  )}
                  <span
                    role="button"
                    onClick={() =>
                      setOScreen({ name: 'edit', listingId: l.id })
                    }
                    style={{
                      cursor: 'pointer',
                      color: 'var(--muted)',
                      fontSize: 14,
                    }}
                  >
                    ✎
                  </span>
                </div>
                <div className="k" style={{ fontSize: 11, marginTop: 4 }}>
                  updated {rel(l.updated)}
                </div>
              </div>
            </div>
          );
        });
      })()}
    </div>
  );

  const OwnerReservations = () => {
    const pending = reservations.filter(
      (res) => res.shopId === myShopId && res.status === 'pending'
    );
    const held = reservations.filter(
      (res) => res.shopId === myShopId && res.status === 'held'
    );
    const Card = ({ res, children }) => {
      const r = relById[res.releaseId];
      return (
        <div className="card" style={{ padding: '11px 13px', marginBottom: 8 }}>
          <div className="row">
            <Sleeve release={r} size={44} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="serif" style={{ fontSize: 15, fontWeight: 600 }}>
                {r.title}
              </div>
              <div className="k">
                {r.artist} · requested {rel(res.created)}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            {children}
          </div>
        </div>
      );
    };
    return (
      <div style={{ padding: '10px 18px 20px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
          Requests to approve
        </div>
        {pending.length === 0 ? (
          <div className="k" style={{ textAlign: 'center', padding: '20px' }}>
            No new requests.
          </div>
        ) : (
          pending.map((res) => (
            <Card key={res.id} res={res}>
              <button
                className="btn-rust"
                style={{ padding: '9px 0', fontSize: 13 }}
                onClick={() => acceptReservation(res)}
              >
                Accept
              </button>
              <button
                className="btn-ghost"
                style={{ flex: 1, padding: '9px 0', fontSize: 13 }}
                onClick={() => declineReservation(res)}
              >
                Decline
              </button>
            </Card>
          ))
        )}

        <div style={{ fontSize: 15, fontWeight: 600, margin: '18px 0 10px' }}>
          Pickups waiting
        </div>
        {held.length === 0 ? (
          <div className="k" style={{ textAlign: 'center', padding: '20px' }}>
            No pickups waiting.
          </div>
        ) : (
          held.map((res) => (
            <Card key={res.id} res={res}>
              <button
                className="btn-rust"
                style={{ padding: '9px 0', fontSize: 13 }}
                onClick={() => markPickedUp(res)}
              >
                Mark picked up
              </button>
              <button
                className="btn-ghost"
                style={{ flex: 1, padding: '9px 0', fontSize: 13 }}
                onClick={() => cancelReservation(res)}
              >
                Release
              </button>
            </Card>
          ))
        )}
      </div>
    );
  };

  const OwnerSettings = () => (
    <div style={{ padding: '14px 18px 20px' }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
        Settings
      </div>
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div className="k">Signed in as</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
          {currentUser.name}
        </div>
        <div className="k">{currentUser.email}</div>
      </div>
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {myShop ? myShop.name : 'Your shop'}
        </div>
        <div className="k">
          {myShop ? myShop.hood : ''}
          {myShop && myShop.address ? ' · ' + myShop.address : ''}
        </div>
        <div className="k" style={{ marginTop: 6 }}>
          Discogs:{' '}
          {myShop && myShop.discogs
            ? myShop.discogs + ' (syncing)'
            : 'not connected'}
        </div>
      </div>
      <div className="k" style={{ marginBottom: 12 }}>
        Stock and reservations are shared — every visitor to the app sees them.
        Your saved records stay private to your account.
      </div>
      <button className="btn-ghost" style={{ width: '100%' }} onClick={logout}>
        Log out
      </button>
    </div>
  );

  // ---- assembly ----
  // Screens are invoked as functions (not <Comp/>) so they inline into this
  // render — that keeps text inputs from losing focus on each keystroke.
  const buyerContent =
    bScreen.name === 'stores'
      ? StoresScreen()
      : bScreen.name === 'shop'
      ? ShopScreen()
      : bScreen.name === 'detail'
      ? BuyerDetail()
      : bScreen.name === 'saved'
      ? BuyerSaved()
      : bScreen.name === 'reserved'
      ? BuyerReserved()
      : BuyerSearch();
  const ownerContent =
    oScreen.name === 'add' ? (
      <AddRecord
        releases={catalog.releases}
        listings={listings}
        shopId={myShopId}
        onSave={addRecord}
        onCancel={() => setOScreen({ name: 'stock' })}
      />
    ) : oScreen.name === 'edit' ? (
      <EditRecord
        listing={listings.find((l) => l.id === oScreen.listingId)}
        release={
          relById[listings.find((l) => l.id === oScreen.listingId)?.releaseId]
        }
        onSave={saveEdit}
        onDelete={deleteListing}
        onCancel={() => setOScreen({ name: 'stock' })}
        onSetImage={setReleaseImage}
        onSetTracklist={setReleaseTracklist}
      />
    ) : oScreen.name === 'reservations' ? (
      OwnerReservations()
    ) : oScreen.name === 'settings' ? (
      OwnerSettings()
    ) : (
      OwnerStock()
    );

  const pendingCount = isOwner
    ? reservations.filter(
        (r) => r.shopId === myShopId && r.status === 'pending'
      ).length
    : 0;
  const buyerTabs = [
    ['stores', '⌂', 'Stores'],
    ['search', '⌕', 'Search'],
    ['saved', '♡', 'Saved'],
    ['reserved', '◷', 'Reserved'],
  ];
  const ownerTabs = [
    ['stock', '≣', 'Stock'],
    ['reservations', '◷', 'Pickups'],
    ['settings', '⚙', 'Shop'],
  ];
  const ownerMode = isOwner && mode === 'owner';

  return (
    <div
      className="rille"
      style={{
        minHeight: '100dvh',
        background: '#000000',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      {styleTag}
      <div
        style={{
          width: '100%',
          maxWidth: 393,
          background: 'var(--cream)',
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        <div
          style={{
            padding: '16px 18px 12px',
            borderBottom: '0.5px solid var(--line)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: isOwner ? 12 : 0,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Disc size={26} />
              <span
                className="serif"
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  letterSpacing: '.01em',
                }}
              >
                Crate Digging
              </span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="k">{currentUser.name.split(' ')[0]}</span>
              <span
                role="button"
                onClick={logout}
                className="k"
                style={{ cursor: 'pointer', color: 'var(--rust)' }}
              >
                Log out
              </span>
            </span>
          </div>
          {isOwner && (
            <div className="modeseg">
              <button
                className={mode === 'buyer' ? 'on' : ''}
                onClick={() => setMode('buyer')}
              >
                Shopping
              </button>
              <button
                className={mode === 'owner' ? 'on' : ''}
                onClick={() => setMode('owner')}
              >
                My shop
              </button>
            </div>
          )}
        </div>

        <div className="scroll">{ownerMode ? ownerContent : buyerContent}</div>

        {toast && (
          <div
            style={{
              position: 'absolute',
              bottom: 76,
              left: 0,
              right: 0,
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                background: 'var(--card)',
                color: 'var(--ink)',
                border: '0.5px solid var(--line)',
                fontSize: 13,
                padding: '8px 16px',
                borderRadius: 999,
              }}
            >
              {toast}
            </div>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            padding: '10px 8px 14px',
            background: 'var(--panel)',
            borderTop: '0.5px solid var(--line)',
          }}
        >
          {(ownerMode ? ownerTabs : buyerTabs).map(([key, icon, label]) => {
            const active = ownerMode
              ? oScreen.name === key ||
                (key === 'stock' &&
                  (oScreen.name === 'add' || oScreen.name === 'edit'))
              : bScreen.name === key ||
                (key === 'search' && bScreen.name === 'detail') ||
                (key === 'stores' && bScreen.name === 'shop');
            return (
              <button
                key={key}
                className={'tab' + (active ? ' active' : '')}
                onClick={() =>
                  ownerMode
                    ? setOScreen({ name: key })
                    : setBScreen({ name: key })
                }
              >
                <span className="tabicon" style={{ position: 'relative' }}>
                  {icon}
                  {key === 'reservations' && pendingCount > 0 && (
                    <span
                      style={{
                        position: 'absolute',
                        top: -4,
                        right: -10,
                        minWidth: 15,
                        height: 15,
                        padding: '0 3px',
                        borderRadius: 999,
                        background: 'var(--rust)',
                        color: 'var(--cream)',
                        fontSize: 10,
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {pendingCount}
                    </span>
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
