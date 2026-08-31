const { useState, useEffect, useRef, useMemo } = React;

// ============================================================
// Firebase — shared data (shops: categories, items, reps, activity)
// lives here so every phone sees the same live data. Auth is
// anonymous (silent, no login screen) purely so Firestore's
// security rules can require "signed in" before allowing access.
// ============================================================
let db = null;
let firebaseReady = false;
function initFirebase() {
  if (firebaseReady) return;
  if (!window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey === "PASTE_ME") {
    console.warn("Firebase config missing — paste it into index.html. Falling back to local-only mode.");
    return;
  }
  firebase.initializeApp(window.FIREBASE_CONFIG);
  db = firebase.firestore();
  firebaseReady = true;
}

// Local, per-device settings only — never shared data.
const storage = {
  async get(key) {
    const v = localStorage.getItem(key);
    if (v === null) throw new Error("not found");
    return { key, value: v };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
};

// ============================================================
// Constants
// ============================================================
const APP_NAME = "StockPilot";
const AVATAR_INITIALS = "SP";
const BLUE = "#2F5FE0";
const BLUE_DARK = "#1F45B8";
const BLUE_BG = "#EAF0FE";
const SESSION_KEY = "stockpilot:reseller-session-v1";
const API_KEY_STORAGE = "stockpilot:anthropic-key-v1";
const ACTIVE_SHOP_KEY = "stockpilot:active-shop-v1";

// ============================================================
// Icons — plain emoji glyphs, zero dependencies
// ============================================================
function mkIcon(glyph) {
  return function IconCmp({ size = 16, className = "", style = {} }) {
    return React.createElement(
      "span",
      { className, style: { fontSize: size, lineHeight: 1, display: "inline-block", ...style } },
      glyph
    );
  };
}
const Plus = mkIcon("+");
const Minus = mkIcon("\u2212");
const XIcon = mkIcon("\u2715");
const Search = mkIcon("\uD83D\uDD0D");
const Trash2 = mkIcon("\uD83D\uDDD1\uFE0F");
const Edit2 = mkIcon("\u270F\uFE0F");
const Lock = mkIcon("\uD83D\uDD12");
const Copy = mkIcon("\uD83D\uDCCB");
const Download = mkIcon("\u2B07\uFE0F");
const AlertTriangle = mkIcon("\u26A0\uFE0F");
const Check = mkIcon("\u2713");
const Clock = mkIcon("\uD83D\uDD52");
const ChevronDown = mkIcon("\u2304");
const ChevronUp = mkIcon("\u2303");
const MoreVertical = mkIcon("\u22EE");
const Mail = mkIcon("\u2709\uFE0F");
const UserPlus = mkIcon("\uD83D\uDC64");
const ActivityIcon = mkIcon("\uD83D\uDCC8");
const ShieldCheck = mkIcon("\uD83D\uDEE1\uFE0F");
const LayoutList = mkIcon("\uD83E\uDDFE");
const Zap = mkIcon("\u26A1");
const LogOut = mkIcon("\u21A9\uFE0F");
const KeyRound = mkIcon("\uD83D\uDD11");
const Tag = mkIcon("\uD83C\uDFF7\uFE0F");
const Store = mkIcon("\uD83C\uDFEC");
const Settings = mkIcon("\u2699\uFE0F");

// ============================================================
// Helpers
// ============================================================
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const now = () => new Date().toISOString();
const fmtDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const naira = (n) => `\u20A6${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

function genCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function gaugeInfo(total) {
  if (total > 30) return { dot: "#1B9C4B", text: "#1B9C4B", bar: "#22C069", badgeBg: "#E7F8ED", label: "Good" };
  if (total >= 21) return { dot: "#E38B12", text: "#B8710E", bar: "#F0A93A", badgeBg: "#FEF3E2", label: "Low" };
  return { dot: "#DC3B33", text: "#C42E27", bar: "#EA5A52", badgeBg: "#FDEAEA", label: "Reorder" };
}

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pruneHistory(shop) {
  if (!shop.historyRetentionDays || shop.historyRetentionDays === "forever") return shop;
  const cutoff = Date.now() - shop.historyRetentionDays * 86400000;
  return {
    ...shop,
    categories: shop.categories.map((c) => ({
      ...c,
      items: c.items.map((it) => ({ ...it, history: (it.history || []).filter((h) => new Date(h.ts).getTime() >= cutoff) })),
    })),
    activityLog: (shop.activityLog || []).filter((a) => new Date(a.ts).getTime() >= cutoff),
  };
}

function defaultShop(name) {
  return { id: uid(), name, historyRetentionDays: 90, categories: [], reps: [], activityLog: [], createdAt: now() };
}

// Appends one activity-log entry to a shop object. Used INSIDE the same
// updateShop() call that also changes stock, so the quantity change and its
// log entry are written together, atomically — never as two separate writes.
function withActivity(shop, action, details, who) {
  return { ...shop, activityLog: [{ id: uid(), ts: now(), actingAs: who, action, details }, ...(shop.activityLog || [])] };
}

const DEFAULT_PERMS = { canStockIn: true, canStockOut: true };
const repPerms = (rep) => rep?.permissions || DEFAULT_PERMS;

// Local, offline category-suggestion templates — used whenever no API key is set,
// or if a live AI call fails. Keeps "AI Setup" useful with zero network dependency.
const SHOP_TEMPLATES = [
  { keywords: ["provision", "grocery", "convenience", "mini mart", "supermarket"], categories: [
    { name: "Beverages", description: "Soft drinks, juices, and bottled water" },
    { name: "Grains & Rice", description: "Rice, beans, garri, and other staples" },
    { name: "Canned & Packaged Foods", description: "Tinned tomatoes, sardines, noodles" },
    { name: "Toiletries", description: "Soap, toothpaste, and personal care" },
    { name: "Snacks & Confectionery", description: "Biscuits, sweets, and chin-chin" },
    { name: "Household Items", description: "Detergents, tissue, and cleaning supplies" },
  ]},
  { keywords: ["hardware", "tools", "building", "cement", "construction"], categories: [
    { name: "Hand Tools", description: "Hammers, spanners, screwdrivers" },
    { name: "Plumbing Supplies", description: "Pipes, fittings, and taps" },
    { name: "Electrical Supplies", description: "Cables, sockets, and switches" },
    { name: "Paints & Finishes", description: "Paints, brushes, and thinners" },
    { name: "Fasteners", description: "Nails, screws, and bolts" },
  ]},
  { keywords: ["pharmacy", "chemist", "drug"], categories: [
    { name: "Pain Relief", description: "Analgesics and fever medication" },
    { name: "Antibiotics", description: "Prescription antibiotics" },
    { name: "Vitamins & Supplements", description: "Multivitamins and supplements" },
    { name: "First Aid", description: "Dressings, plasters, and antiseptics" },
    { name: "Mother & Baby Care", description: "Baby formula and care items" },
  ]},
  { keywords: ["phone", "electronics", "gadget", "accessories"], categories: [
    { name: "Phone Accessories", description: "Chargers, cables, and cases" },
    { name: "Earphones & Speakers", description: "Audio accessories" },
    { name: "Power Banks", description: "Portable chargers" },
    { name: "Screen Protectors", description: "Glass and film protectors" },
  ]},
  { keywords: ["boutique", "clothing", "fashion", "wear", "clothes"], categories: [
    { name: "Men's Wear", description: "Shirts, trousers, and suits" },
    { name: "Women's Wear", description: "Dresses, tops, and skirts" },
    { name: "Footwear", description: "Shoes and sandals" },
    { name: "Accessories", description: "Bags, belts, and jewelry" },
  ]},
  { keywords: ["cosmetics", "beauty", "salon", "hair", "barber"], categories: [
    { name: "Skincare", description: "Creams, lotions, and soaps" },
    { name: "Makeup", description: "Foundation, lipstick, and powder" },
    { name: "Hair Products", description: "Shampoo, relaxers, and oils" },
    { name: "Salon Supplies", description: "Combs, clippers, and tools" },
  ]},
  { keywords: ["stationery", "bookshop", "books", "school"], categories: [
    { name: "Writing Materials", description: "Pens, pencils, and markers" },
    { name: "Exercise Books", description: "Notebooks and jotters" },
    { name: "School Bags", description: "Bags and backpacks" },
    { name: "Office Supplies", description: "Files, staplers, and folders" },
  ]},
  { keywords: ["restaurant", "food", "eatery", "kitchen", "provisions store"], categories: [
    { name: "Fresh Produce", description: "Vegetables and fruits" },
    { name: "Proteins", description: "Meat, fish, and poultry" },
    { name: "Spices & Seasoning", description: "Seasoning cubes and spices" },
    { name: "Cooking Oils", description: "Vegetable and palm oil" },
  ]},
  { keywords: ["auto", "car", "spare parts", "mechanic"], categories: [
    { name: "Engine Parts", description: "Belts, filters, and plugs" },
    { name: "Tyres & Batteries", description: "Tyres and car batteries" },
    { name: "Lubricants", description: "Engine oil and grease" },
    { name: "Body Parts", description: "Bumpers, mirrors, and lights" },
  ]},
];
function localSuggestCategories(query) {
  const q = query.toLowerCase();
  const match = SHOP_TEMPLATES.find((t) => t.keywords.some((k) => q.includes(k)));
  if (match) return match.categories;
  return [
    { name: "General Items", description: "Everyday items this shop sells" },
    { name: "Fast-Moving Goods", description: "Your best-selling items" },
    { name: "Seasonal Stock", description: "Items that sell more at certain times" },
    { name: "Accessories", description: "Add-ons and extras" },
  ];
}

// ============================================================
// Export helpers — plain browser download, with Web Share as a
// mobile-friendly bonus and clipboard-copy as a bulletproof fallback.
// ============================================================
function toCSV(rows, columns) {
  const header = columns.map((c) => c.label).join(",");
  const lines = rows.map((r) => columns.map((c) => `"${(r[c.key] ?? "").toString().replace(/"/g, '""')}"`).join(","));
  return [header, ...lines].join("\n");
}

async function exportFile(blob, filename, mime, notify) {
  try {
    if (navigator.canShare && navigator.share) {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        notify?.("Shared — choose where to save it");
        return;
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    notify?.("Download started");
  } catch (e) {
    notify?.("Couldn't download automatically — try Copy instead");
  }
}

async function copyText(text, notify) {
  try {
    await navigator.clipboard.writeText(text);
    notify?.("Copied to clipboard");
  } catch (e) {
    notify?.("Couldn't copy — clipboard access may be blocked");
  }
}

// ============================================================
// UI atoms
// ============================================================
function Modal({ children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className={`bg-white w-full ${wide ? "sm:max-w-lg" : "sm:max-w-sm"} rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto shadow-2xl`}>
        {children}
      </div>
    </div>
  );
}

function ConfirmModal({ title, body, confirmLabel = "Confirm", danger, onConfirm, onCancel }) {
  return (
    <Modal>
      <div className="p-5">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle size={20} className={danger ? "text-[#C42E27]" : "text-[#B8710E]"} />
          <h3 className="font-bold text-[#111827] text-lg">{title}</h3>
        </div>
        <p className="text-sm text-[#6B7280] mb-5 leading-relaxed">{body}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-[#374151] font-medium text-sm">Cancel</button>
          <button onClick={onConfirm} style={{ background: danger ? "#C42E27" : BLUE }} className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white">{confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

function SectionHeader({ icon: Icon, avatarText, title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between mb-4 gap-2">
      <div className="flex items-center gap-3 min-w-0">
        {avatarText ? (
          <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm text-white shrink-0" style={{ background: BLUE }}>{avatarText}</div>
        ) : Icon ? (
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: BLUE_BG }}><Icon size={18} style={{ color: BLUE }} /></div>
        ) : null}
        <div className="min-w-0">
          <h2 className="font-bold text-[#111827] text-lg leading-tight truncate">{title}</h2>
          {subtitle && <p className="text-xs text-[#6B7280] mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function PillButton({ children, onClick, icon: Icon, variant = "solid", disabled, className = "" }) {
  const base = "flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold whitespace-nowrap shrink-0 disabled:opacity-40";
  const styles = variant === "solid" ? { background: BLUE, color: "white" } : variant === "soft" ? { background: BLUE_BG, color: BLUE } : {};
  const outline = variant === "outline" ? "border border-[#E4E7EC] text-[#374151] bg-white" : "";
  return (
    <button onClick={onClick} disabled={disabled} style={styles} className={`${base} ${outline} ${className}`}>
      {Icon && <Icon size={15} />} {children}
    </button>
  );
}

// ============================================================
// App
// ============================================================
function App() {
  const [shops, setShops] = useState(null);
  const [activeShopId, setActiveShopIdState] = useState(null);
  const [tab, setTab] = useState("inventory");
  const [actingAs, setActingAs] = useState("Owner");
  const [toast, setToast] = useState(null);
  const [session, setSession] = useState(null);
  const [showResellerAuth, setShowResellerAuth] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [syncStatus, setSyncStatus] = useState("connecting"); // connecting | live | local-only | offline

  function setActiveShopId(id) {
    setActiveShopIdState(id);
    if (id) localStorage.setItem(ACTIVE_SHOP_KEY, id);
  }

  // ---- Firestore wiring: one collection, "shops", one doc per shop ----
  useEffect(() => {
    initFirebase();
    if (!firebaseReady) {
      // No Firebase config yet — fall back to a single local-only shop so the
      // app is still usable while you finish the Firebase setup steps.
      setSyncStatus("local-only");
      const s = defaultShop("My Shop");
      setShops([s]);
      setActiveShopIdState(localStorage.getItem(ACTIVE_SHOP_KEY) || s.id);
      return;
    }

    let unsubSnapshot = () => {};
    firebase.auth().signInAnonymously().catch((e) => {
      console.error("Firebase auth failed", e);
      setSyncStatus("offline");
    });

    const unsubAuth = firebase.auth().onAuthStateChanged((user) => {
      if (!user) return;
      unsubSnapshot();
      unsubSnapshot = db.collection("shops").onSnapshot(
        (snap) => {
          const list = snap.docs.map((d) => d.data());
          if (list.length === 0) {
            const s = defaultShop("My Shop");
            db.collection("shops").doc(s.id).set(s).catch(() => {});
            return; // the snapshot listener will fire again once this write lands
          }
          setShops(list);
          setSyncStatus("live");
          setActiveShopIdState((prev) => {
            const saved = localStorage.getItem(ACTIVE_SHOP_KEY);
            if (prev && list.some((s) => s.id === prev)) return prev;
            if (saved && list.some((s) => s.id === saved)) return saved;
            return list[0]?.id || null;
          });
        },
        (err) => { console.error("Firestore listen failed", err); setSyncStatus("offline"); }
      );
    });

    return () => { unsubAuth(); unsubSnapshot(); };
  }, []);

  function showToast(msg) {
    setToast(msg);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => setToast(null), 2200);
  }

  function createShop(shop) {
    if (!firebaseReady) { setShops((prev) => [...prev, shop]); return; }
    db.collection("shops").doc(shop.id).set(shop).catch(() => showToast("Couldn't sync — will retry when back online"));
  }
  function removeShop(id) {
    if (!firebaseReady) { setShops((prev) => prev.filter((s) => s.id !== id)); return; }
    db.collection("shops").doc(id).delete().catch(() => showToast("Couldn't sync — will retry when back online"));
  }
  // Reads the CURRENT server document inside a transaction, applies your
  // change on top of it, and writes it back atomically. This is what stops
  // two near-simultaneous saves (e.g. a stock edit immediately followed by
  // its own activity-log entry, or two different phones saving around the
  // same moment) from overwriting each other — each transaction always
  // starts from the true latest state, not a possibly-stale local copy.
  async function updateShop(id, updater) {
    if (!firebaseReady) {
      setShops((prev) => prev.map((s) => (s.id === id ? pruneHistory(updater(s)) : s)));
      return;
    }
    const ref = db.collection("shops").doc(id);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const next = pruneHistory(updater(snap.data()));
        tx.set(ref, next);
      });
    } catch (e) {
      showToast("Couldn't sync — will retry when back online");
    }
  }

  function logActivity(shopId, action, details, who) {
    updateShop(shopId, (s) => withActivity(s, action, details, who));
  }

  function loginSession(sess) {
    setSession(sess);
    storage.set(SESSION_KEY, JSON.stringify(sess)).catch(() => {});
  }
  function logout() {
    setSession(null);
    storage.delete(SESSION_KEY).catch(() => {});
  }

  useEffect(() => { (async () => { try { const res2 = await storage.get(SESSION_KEY); setSession(JSON.parse(res2.value)); } catch {} })(); }, []);

  const activeShop = shops?.find((s) => s.id === activeShopId) || null;
  const repNames = activeShop ? activeShop.reps.filter((r) => r.activated).map((r) => r.name) : [];
  const actingOptions = ["Owner", ...repNames];
  useEffect(() => { if (!actingOptions.includes(actingAs)) setActingAs("Owner"); }, [activeShopId]);

  if (!shops) {
    return <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA] text-[#6B7280]">Loading your shops…</div>;
  }

  if (session) {
    const shop = shops.find((s) => s.id === session.shopId);
    const rep = shop?.reps.find((r) => r.id === session.repId);
    if (shop && rep) {
      return <ResellerView shop={shop} rep={rep} updateShop={updateShop} logActivity={logActivity} onLogout={logout} showToast={showToast} />;
    }
    logout();
  }

  const tabs = [
    { id: "inventory", label: "Inventory", icon: Store },
    { id: "statement", label: "Statement", icon: LayoutList },
    { id: "admin", label: "Admin", icon: ShieldCheck },
  ];

  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#111827] flex flex-col pb-20" style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div className="bg-[#111827] text-center py-1.5 px-4 flex items-center justify-center gap-4">
        <span className="text-[11px] font-medium flex items-center gap-1" style={{ color: syncStatus === "live" ? "#7BE0A0" : syncStatus === "offline" ? "#F5A3A0" : "#C7D2FE" }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", display: "inline-block" }} />
          {syncStatus === "live" ? "Synced live" : syncStatus === "offline" ? "Offline — will resync" : syncStatus === "local-only" ? "Local only (add Firebase config)" : "Connecting…"}
        </span>
        <button onClick={() => setShowResellerAuth(true)} className="text-[11px] font-medium text-[#C7D2FE] flex items-center gap-1"><KeyRound size={11} /> Reseller sign-in</button>
        <button onClick={() => setShowApiKeyModal(true)} className="text-[11px] font-medium text-[#C7D2FE] flex items-center gap-1"><Settings size={11} /> AI Setup key</button>
      </div>

      {activeShop && (
        <>
          {tab === "inventory" && (
            <TopBar shops={shops} activeShopId={activeShopId} setActiveShopId={setActiveShopId} createShop={createShop} removeShop={removeShop} updateShop={updateShop} showToast={showToast} actingAs={actingAs} setActingAs={setActingAs} actingOptions={actingOptions} />
          )}
          <main className="flex-1 px-4 py-4">
            {tab === "inventory" && (
              <InventoryTab shop={activeShop} updateShop={updateShop} logActivity={logActivity} actingAs={actingAs} shops={shops} createShop={createShop} setActiveShopId={setActiveShopId} showToast={showToast} />
            )}
            {tab === "statement" && <StatementTab shop={activeShop} showToast={showToast} />}
            {tab === "admin" && <AdminTab shop={activeShop} updateShop={updateShop} showToast={showToast} />}
          </main>
        </>
      )}

      {toast && <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-[#111827] text-white text-sm px-4 py-2.5 rounded-full shadow-lg z-50">{toast}</div>}

      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-[#E4E7EC] flex items-stretch z-40" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className="flex-1 flex flex-col items-center gap-1 py-2.5">
              <t.icon size={20} style={{ color: active ? BLUE : "#9CA3AF" }} />
              <span className="text-[11px] font-medium" style={{ color: active ? BLUE : "#9CA3AF" }}>{t.label}</span>
            </button>
          );
        })}
      </nav>

      {showResellerAuth && <ResellerAuthModal shops={shops} updateShop={updateShop} onClose={() => setShowResellerAuth(false)} onLoggedIn={(sess) => { loginSession(sess); setShowResellerAuth(false); }} />}
      {showApiKeyModal && <ApiKeyModal onClose={() => setShowApiKeyModal(false)} showToast={showToast} />}
    </div>
  );
}

function ApiKeyModal({ onClose, showToast }) {
  const [key, setKey] = useState("");
  useEffect(() => { (async () => { try { const r = await storage.get(API_KEY_STORAGE); setKey(JSON.parse(r.value).key || ""); } catch {} })(); }, []);
  async function save() {
    await storage.set(API_KEY_STORAGE, JSON.stringify({ key: key.trim() }));
    showToast("Saved");
    onClose();
  }
  async function clear() {
    await storage.delete(API_KEY_STORAGE).catch(() => {});
    setKey("");
    showToast("API key removed — AI Setup will use built-in suggestions");
  }
  return (
    <Modal>
      <div className="p-5">
        <h3 className="font-bold text-lg mb-2 text-[#111827]">AI Setup — Anthropic API key</h3>
        <p className="text-xs text-[#6B7280] mb-3 leading-relaxed">
          Optional. Without a key, "AI Setup" still works using a small built-in list of common Nigerian shop types.
          Add your own key from <span className="font-medium">console.anthropic.com</span> for live, tailored suggestions for any business type.
          The key is stored only on this phone and is sent directly from your browser to Anthropic — never through any server of ours.
        </p>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-..." className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-3 font-mono" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-sm font-medium text-[#374151]">Cancel</button>
          <button onClick={clear} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-sm font-medium text-[#C42E27]">Remove key</button>
          <button onClick={save} style={{ background: BLUE }} className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold">Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// Reseller sign-in / activation
// ============================================================
function ResellerAuthModal({ shops, updateShop, onClose, onLoggedIn }) {
  const [mode, setMode] = useState("code");
  const [code, setCode] = useState("");
  const [found, setFound] = useState(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [error, setError] = useState("");

  function lookupCode() {
    setError("");
    const c = code.trim().toUpperCase();
    if (!c) return;
    for (const shop of shops) {
      const rep = shop.reps.find((r) => r.code === c && !r.activated);
      if (rep) { setFound({ shopId: shop.id, repId: rep.id, ...rep }); return; }
    }
    setError("That code wasn't found, or it's already been used. Ask your shop owner for a new one.");
  }

  async function activate() {
    if (pw.length < 6) return setError("Use at least 6 characters.");
    if (pw !== pw2) return setError("Passwords don't match.");
    const hash = await sha256(pw);
    updateShop(found.shopId, (s) => ({ ...s, reps: s.reps.map((r) => r.id !== found.repId ? r : { ...r, activated: true, passwordHash: hash, activatedAt: now() }) }));
    onLoggedIn({ shopId: found.shopId, repId: found.repId, name: found.name });
  }

  async function login() {
    setError("");
    const email = loginEmail.trim().toLowerCase();
    for (const shop of shops) {
      const rep = shop.reps.find((r) => r.activated && (r.email || "").trim().toLowerCase() === email);
      if (rep) {
        const attempt = await sha256(loginPw);
        if (attempt === rep.passwordHash) { onLoggedIn({ shopId: shop.id, repId: rep.id, name: rep.name }); return; }
        setError("Incorrect password."); return;
      }
    }
    setError("No active reseller found with that email.");
  }

  return (
    <Modal>
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-lg text-[#111827]">Reseller access</h3>
          <button onClick={onClose}><XIcon size={18} className="text-[#9CA3AF]" /></button>
        </div>
        <div className="flex gap-1 bg-[#F1F3F6] rounded-xl p-1 mb-4">
          <button onClick={() => { setMode("code"); setError(""); }} className="flex-1 py-1.5 rounded-lg text-xs font-semibold" style={mode === "code" ? { background: "white", color: BLUE } : { color: "#6B7280" }}>First time (have a code)</button>
          <button onClick={() => { setMode("login"); setError(""); }} className="flex-1 py-1.5 rounded-lg text-xs font-semibold" style={mode === "login" ? { background: "white", color: BLUE } : { color: "#6B7280" }}>Log in</button>
        </div>

        {mode === "code" && !found && (
          <>
            <label className="text-xs font-medium text-[#9CA3AF]">Connection code</label>
            <input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. K7M2QRXA" className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-3 tracking-widest font-mono" />
            {error && <p className="text-xs text-[#C42E27] mb-3">{error}</p>}
            <button onClick={lookupCode} disabled={!code.trim()} style={{ background: BLUE }} className="w-full py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-40">Continue</button>
          </>
        )}

        {mode === "code" && found && (
          <>
            <div className="bg-[#F5F7FA] rounded-xl p-3 mb-3 text-sm">
              <p className="font-semibold text-[#111827] mb-1">Confirm your details</p>
              <p className="text-[#6B7280]">{found.name} · {found.phone}</p>
              <p className="text-[#6B7280]">{found.shopAddress}</p>
              <p className="text-[#6B7280]">{found.email}</p>
            </div>
            <label className="text-xs font-medium text-[#9CA3AF]">Create a password</label>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-2" />
            <label className="text-xs font-medium text-[#9CA3AF]">Confirm password</label>
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-3" />
            {error && <p className="text-xs text-[#C42E27] mb-3">{error}</p>}
            <button onClick={activate} style={{ background: BLUE }} className="w-full py-2.5 rounded-xl text-white text-sm font-semibold">Set password & continue</button>
          </>
        )}

        {mode === "login" && (
          <>
            <label className="text-xs font-medium text-[#9CA3AF]">Email</label>
            <input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-2" />
            <label className="text-xs font-medium text-[#9CA3AF]">Password</label>
            <input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-3" />
            {error && <p className="text-xs text-[#C42E27] mb-3">{error}</p>}
            <button onClick={login} style={{ background: BLUE }} className="w-full py-2.5 rounded-xl text-white text-sm font-semibold">Log in</button>
          </>
        )}

        <p className="text-[11px] text-[#C9CDD6] mt-4 leading-relaxed">Everything is stored on this phone only. If a reseller needs to work from their own phone, they should install this same app there and use their code on that device.</p>
      </div>
    </Modal>
  );
}

function ResellerView({ shop, rep, updateShop, logActivity, onLogout, showToast }) {
  const [tab, setTab] = useState("inventory");
  const permissions = repPerms(rep);
  const tabs = [{ id: "inventory", label: "Inventory", icon: Store }, { id: "statement", label: "Statement", icon: LayoutList }];
  return (
    <div className="min-h-screen bg-[#F5F7FA] text-[#111827] flex flex-col pb-20" style={{ fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div className="bg-white border-b border-[#E4E7EC] px-4 pt-5 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm text-white shrink-0" style={{ background: BLUE }}>{initials(rep.name)}</div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-[#111827] leading-tight">{rep.name}</h1>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: BLUE_BG, color: BLUE }}>Reseller</span>
              </div>
              <p className="text-xs text-[#9CA3AF]">{shop.name}</p>
            </div>
          </div>
          <button onClick={onLogout} className="flex items-center gap-1 text-xs font-medium text-[#9CA3AF]"><LogOut size={13} /> Log out</button>
        </div>
        <div className="grid grid-cols-1 gap-1 mt-3 text-xs text-[#6B7280] bg-[#F5F7FA] rounded-xl p-3">
          <div>{rep.phone}</div>
          <div>{rep.shopAddress}</div>
          <div>{rep.email}</div>
        </div>
        <p className="text-[11px] text-[#9CA3AF] mt-2">Everything you record below is saved under your name.</p>
      </div>
      <main className="flex-1 px-4 py-4">
        {tab === "inventory" && <InventoryTab shop={shop} updateShop={updateShop} logActivity={logActivity} actingAs={rep.name} shops={[shop]} createShop={() => {}} setActiveShopId={() => {}} showToast={showToast} hideShopSwap permissions={permissions} />}
        {tab === "statement" && <StatementTab shop={shop} showToast={showToast} />}
      </main>
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-[#E4E7EC] flex items-stretch z-40" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className="flex-1 flex flex-col items-center gap-1 py-2.5">
              <t.icon size={20} style={{ color: active ? BLUE : "#9CA3AF" }} />
              <span className="text-[11px] font-medium" style={{ color: active ? BLUE : "#9CA3AF" }}>{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ============================================================
// Top bar
// ============================================================
function TopBar({ shops, activeShopId, setActiveShopId, createShop, removeShop, updateShop, showToast, actingAs, setActingAs, actingOptions }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showRename, setShowRename] = useState(null);
  const [showDelete, setShowDelete] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState("");
  const activeShop = shops.find((s) => s.id === activeShopId);

  function addShop() {
    if (!name.trim()) return;
    const s = defaultShop(name.trim());
    createShop(s);
    setActiveShopId(s.id);
    setShowAdd(false); setName("");
    showToast(`${s.name} created`);
  }
  function renameShop() {
    if (!name.trim()) return;
    updateShop(showRename.id, (s) => ({ ...s, name: name.trim() }));
    setShowRename(null); setName("");
  }
  function deleteShop() {
    removeShop(showDelete.id);
    if (activeShopId === showDelete.id) {
      const remaining = shops.filter((s) => s.id !== showDelete.id);
      setActiveShopId(remaining[0]?.id || null);
    }
    setShowDelete(null);
    showToast("Shop deleted");
  }

  return (
    <div className="px-4 pt-4 pb-3 bg-white border-b border-[#E4E7EC]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: BLUE_BG }}><Store size={16} style={{ color: BLUE }} /></div>
          <h1 className="font-bold text-lg tracking-tight text-[#111827]">{APP_NAME}</h1>
        </div>
        <PillButton icon={Plus} variant="soft" onClick={() => { setShowAdd(true); setName(""); }}>Shop</PillButton>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 overflow-x-auto -mx-1 px-1 pb-1 flex-1 min-w-0">
          {shops.map((s) => (
            <button key={s.id} onClick={() => setActiveShopId(s.id)} className="shrink-0 px-3.5 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap" style={s.id === activeShopId ? { background: BLUE, color: "white" } : { background: "#F1F3F6", color: "#6B7280" }}>{s.name}</button>
          ))}
        </div>
        <div className="relative shrink-0">
          <button onClick={() => setMenuOpen((o) => !o)} className="w-8 h-8 rounded-full bg-[#F1F3F6] flex items-center justify-center text-[#6B7280]"><MoreVertical size={15} /></button>
          {menuOpen && (
            <div className="absolute right-0 top-9 bg-white border border-[#E4E7EC] rounded-xl shadow-lg py-1 w-40 z-30">
              <button onClick={() => { setShowRename(activeShop); setName(activeShop.name); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-sm text-[#374151] flex items-center gap-2"><Edit2 size={13} /> Rename shop</button>
              {shops.length > 1 && <button onClick={() => { setShowDelete(activeShop); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-sm text-[#C42E27] flex items-center gap-2"><Trash2 size={13} /> Delete shop</button>}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <span className="text-xs text-[#9CA3AF]">Acting as</span>
        <select value={actingAs} onChange={(e) => setActingAs(e.target.value)} className="text-xs font-semibold bg-[#F1F3F6] rounded-lg px-2 py-1 text-[#374151] border-none">
          {actingOptions.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      {showAdd && (
        <Modal>
          <div className="p-5">
            <h3 className="font-bold text-lg mb-3 text-[#111827]">New shop</h3>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Shop name" className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-4" />
            <div className="flex gap-2">
              <button onClick={() => setShowAdd(false)} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-sm font-medium text-[#374151]">Cancel</button>
              <button onClick={addShop} style={{ background: BLUE }} className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold">Create</button>
            </div>
          </div>
        </Modal>
      )}
      {showRename && (
        <Modal>
          <div className="p-5">
            <h3 className="font-bold text-lg mb-3 text-[#111827]">Rename shop</h3>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-4" />
            <div className="flex gap-2">
              <button onClick={() => setShowRename(null)} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-sm font-medium text-[#374151]">Cancel</button>
              <button onClick={renameShop} style={{ background: BLUE }} className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold">Save</button>
            </div>
          </div>
        </Modal>
      )}
      {showDelete && <ConfirmModal title={`Delete "${showDelete.name}"?`} body="This permanently removes this shop, its categories, items, and history. This can't be undone." confirmLabel="Delete shop" danger onConfirm={deleteShop} onCancel={() => setShowDelete(null)} />}
    </div>
  );
}

// ============================================================
// Inventory
// ============================================================
function InventoryTab({ shop, updateShop, logActivity, actingAs, shops, createShop, setActiveShopId, showToast, hideShopSwap, permissions }) {
  const [addCat, setAddCat] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const catMatches = (cat) => cat.name.toLowerCase().includes(q) || (cat.description || "").toLowerCase().includes(q);
  const itemMatches = (item) => item.name.toLowerCase().includes(q) || (item.brand || "").toLowerCase().includes(q) || String(item.price ?? "").includes(q);

  const visibleCategories = q === "" ? shop.categories : shop.categories
    .map((cat) => { const cMatch = catMatches(cat); const items = cMatch ? cat.items : cat.items.filter(itemMatches); return { ...cat, items, _forceShowAll: cMatch }; })
    .filter((cat) => cat._forceShowAll || cat.items.length > 0);

  const resultCount = q === "" ? null : visibleCategories.reduce((n, c) => n + c.items.length, 0);

  return (
    <div className="space-y-5">
      {!hideShopSwap && <ShopSwap shop={shop} shops={shops} createShop={createShop} updateShop={updateShop} setActiveShopId={setActiveShopId} showToast={showToast} />}

      <div className="bg-white border border-[#E4E7EC] rounded-2xl p-3">
        {!searchOpen ? (
          <button onClick={() => setSearchOpen(true)} className="w-full flex items-center gap-2 text-sm text-[#9CA3AF]"><Search size={16} /> Search items, categories, price or brand…</button>
        ) : (
          <div className="flex items-center gap-2">
            <Search size={16} className="text-[#9CA3AF] shrink-0" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search items, categories, price or brand…" className="flex-1 min-w-0 text-sm outline-none" />
            <button onClick={() => { setSearchOpen(false); setQuery(""); }} className="text-[#9CA3AF] shrink-0"><XIcon size={16} /></button>
          </div>
        )}
        {q !== "" && <p className="text-xs text-[#9CA3AF] mt-2">{resultCount} result{resultCount === 1 ? "" : "s"} for "{query}"</p>}
      </div>

      <SectionHeader title={shop.name} subtitle={q === "" ? `${shop.categories.length} categor${shop.categories.length === 1 ? "y" : "ies"}` : "Filtered results"} action={<PillButton icon={Plus} onClick={() => setAddCat(true)}>Category</PillButton>} />

      {shop.categories.length === 0 && <div className="text-center py-10 text-[#9CA3AF] text-sm border border-dashed border-[#E4E7EC] rounded-2xl bg-white">No categories yet. Add one, or try AI Setup above to generate a starter set.</div>}
      {shop.categories.length > 0 && q !== "" && visibleCategories.length === 0 && <div className="text-center py-10 text-[#9CA3AF] text-sm border border-dashed border-[#E4E7EC] rounded-2xl bg-white">Nothing matches "{query}".</div>}

      <div className="space-y-3">
        {visibleCategories.map((cat) => (
          <CategoryCard key={cat.id} shop={shop} cat={cat} updateShop={updateShop} logActivity={logActivity} actingAs={actingAs} forceExpanded={q !== ""} showToast={showToast} permissions={permissions} />
        ))}
      </div>

      {addCat && <CategoryModal onClose={() => setAddCat(false)} onSave={(name, desc) => { updateShop(shop.id, (s) => ({ ...s, categories: [...s.categories, { id: uid(), name, description: desc, items: [] }] })); setAddCat(false); }} />}
    </div>
  );
}

function CategoryModal({ onClose, onSave, initial }) {
  const [name, setName] = useState(initial?.name || "");
  const [desc, setDesc] = useState(initial?.description || "");
  return (
    <Modal>
      <div className="p-5">
        <h3 className="font-bold text-lg mb-3 text-[#111827]">{initial ? "Rename category" : "New category"}</h3>
        <label className="text-xs font-medium text-[#9CA3AF]">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-3 mt-1" />
        <label className="text-xs font-medium text-[#9CA3AF]">Short description</label>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-4 mt-1" placeholder="e.g. Canned foods and grains" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-sm font-medium text-[#374151]">Cancel</button>
          <button disabled={!name.trim()} onClick={() => onSave(name.trim(), desc.trim())} style={{ background: BLUE }} className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-40">Save</button>
        </div>
      </div>
    </Modal>
  );
}

function CategoryCard({ shop, cat, updateShop, logActivity, actingAs, forceExpanded, showToast, permissions }) {
  const [editCat, setEditCat] = useState(false);
  const [delCat, setDelCat] = useState(false);
  const [addItem, setAddItem] = useState(false);
  const [binItemId, setBinItemId] = useState(null);
  const [pending, setPending] = useState({});
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  const total = cat.items.reduce((sum, it) => sum + it.qty, 0);
  const g = gaugeInfo(total);
  const showExpanded = forceExpanded || expanded;
  const liveBinItem = binItemId ? cat.items.find((i) => i.id === binItemId) : null;

  function commitQty(item) {
    const pendingVal = pending[item.id];
    if (pendingVal === undefined || pendingVal === item.qty) return;
    const delta = pendingVal - item.qty; // how much the user wants to add/remove
    updateShop(shop.id, (s) => {
      let logType = null, logMsg = null;
      const next = {
        ...s,
        categories: s.categories.map((c) => {
          if (c.id !== cat.id) return c;
          return { ...c, items: c.items.map((it) => {
            if (it.id !== item.id) return it;
            const before = it.qty;
            const newQty = Math.max(0, before + delta);
            const actualDelta = newQty - before;
            if (actualDelta === 0) return it;
            logType = actualDelta > 0 ? "Stock increased" : "Stock decreased";
            logMsg = `${item.name}: ${before} → ${newQty}`;
            return { ...it, qty: newQty, history: [{ id: uid(), ts: now(), type: actualDelta > 0 ? "IN" : "OUT", qtyChange: actualDelta, newQty, actingAs, note: "Quick edit" }, ...(it.history || [])] };
          }) };
        }),
      };
      return logMsg ? withActivity(next, logType, logMsg, actingAs) : s;
    });
    setPending((p) => { const n = { ...p }; delete n[item.id]; return n; });
  }

  return (
    <div className="bg-white border border-[#E4E7EC] rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.dot }} />
        <h3 className="font-bold text-[#111827] truncate flex-1">{cat.name}</h3>
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: g.badgeBg, color: g.text }}>{total} units · {g.label}</span>
        <div className="relative shrink-0">
          <button onClick={() => setMenuOpen((o) => !o)} className="p-1 text-[#9CA3AF]"><MoreVertical size={16} /></button>
          {menuOpen && (
            <div className="absolute right-0 top-7 bg-white border border-[#E4E7EC] rounded-xl shadow-lg py-1 w-36 z-20">
              <button onClick={() => { setEditCat(true); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-sm text-[#374151] flex items-center gap-2"><Edit2 size={13} /> Rename</button>
              <button onClick={() => { setDelCat(true); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-sm text-[#C42E27] flex items-center gap-2"><Trash2 size={13} /> Delete</button>
            </div>
          )}
        </div>
        {!forceExpanded && <button onClick={() => setExpanded((e) => !e)} className="p-1 text-[#9CA3AF] shrink-0">{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>}
      </div>
      {cat.description && <p className="text-xs text-[#9CA3AF] mt-1 ml-5">{cat.description}</p>}

      <div className="mt-2.5 h-1.5 rounded-full bg-[#F1F3F6] overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.min(100, (total / 50) * 100)}%`, background: g.bar }} /></div>

      {showExpanded && (
        <>
          <div className="mt-3 space-y-1">
            {cat.items.map((item) => {
              const qty = pending[item.id] !== undefined ? pending[item.id] : item.qty;
              const dirty = pending[item.id] !== undefined && pending[item.id] !== item.qty;
              return (
                <div key={item.id} className="flex items-center gap-2 py-2 border-t border-[#F1F3F6] first:border-t-0 first:pt-0">
                  <button onClick={() => setBinItemId(item.id)} className="flex-1 min-w-0 text-left">
                    <div className="text-sm font-semibold text-[#111827] truncate">{item.name}</div>
                    <div className="text-xs text-[#9CA3AF]">{naira(item.price)}{item.brand ? ` · ${item.brand}` : ""}</div>
                  </button>
                  <div className="flex items-center gap-1.5 bg-[#F5F7FA] rounded-full px-1 py-1 shrink-0">
                    <button onClick={() => setPending((p) => ({ ...p, [item.id]: Math.max(0, qty - 1) }))} disabled={permissions && !permissions.canStockOut} className="w-7 h-7 rounded-full bg-white shadow-sm flex items-center justify-center text-[#374151] disabled:opacity-30"><Minus size={13} /></button>
                    <span className="w-7 text-center text-sm font-bold tabular-nums text-[#111827]">{qty}</span>
                    <button onClick={() => setPending((p) => ({ ...p, [item.id]: qty + 1 }))} disabled={permissions && !permissions.canStockIn} className="w-7 h-7 rounded-full bg-white shadow-sm flex items-center justify-center text-[#374151] disabled:opacity-30"><Plus size={13} /></button>
                  </div>
                  <button onClick={() => commitQty(item)} disabled={!dirty} className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={dirty ? { background: "#1B9C4B", color: "white" } : { background: "#F1F3F6", color: "#C9CDD6" }} title="Save"><Check size={14} /></button>
                </div>
              );
            })}
            {cat.items.length === 0 && <p className="text-xs text-[#9CA3AF] py-2">No items yet.</p>}
          </div>
          <button onClick={() => setAddItem(true)} className="mt-3 text-xs font-semibold flex items-center gap-1" style={{ color: BLUE }}><Plus size={13} /> Add Item</button>
        </>
      )}

      {addItem && (
        <ItemModal onClose={() => setAddItem(false)} onSave={(name, qty, price, brand) => {
          updateShop(shop.id, (s) => ({ ...s, categories: s.categories.map((c) => c.id !== cat.id ? c : { ...c, items: [...c.items, { id: uid(), name, qty, price, brand, history: qty > 0 ? [{ id: uid(), ts: now(), type: "IN", qtyChange: qty, newQty: qty, actingAs, note: "Initial stock" }] : [] }] }) }));
          setAddItem(false);
        }} />
      )}
      {editCat && <CategoryModal initial={cat} onClose={() => setEditCat(false)} onSave={(name, desc) => { updateShop(shop.id, (s) => ({ ...s, categories: s.categories.map((c) => c.id === cat.id ? { ...c, name, description: desc } : c) })); setEditCat(false); }} />}
      {delCat && <ConfirmModal title={`Delete "${cat.name}"?`} body={`This removes the category and all ${cat.items.length} item(s) inside it, including their history. This can't be undone.`} confirmLabel="Delete category" danger onConfirm={() => { updateShop(shop.id, (s) => ({ ...s, categories: s.categories.filter((c) => c.id !== cat.id) })); setDelCat(false); }} onCancel={() => setDelCat(false)} />}
      {liveBinItem && <BinCard shop={shop} cat={cat} item={liveBinItem} updateShop={updateShop} logActivity={logActivity} actingAs={actingAs} onClose={() => setBinItemId(null)} showToast={showToast} permissions={permissions} />}
    </div>
  );
}

function ItemModal({ onClose, onSave }) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState(0);
  const [price, setPrice] = useState("");
  const [brand, setBrand] = useState("");
  return (
    <Modal>
      <div className="p-5">
        <h3 className="font-bold text-lg mb-3 text-[#111827]">New item</h3>
        <label className="text-xs font-medium text-[#9CA3AF]">Item name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-3 mt-1" />
        <label className="text-xs font-medium text-[#9CA3AF]">Brand (optional)</label>
        <input value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-3 mt-1" placeholder="e.g. Dangote, Peak" />
        <div className="flex gap-3 mb-4">
          <div className="flex-1">
            <label className="text-xs font-medium text-[#9CA3AF]">Starting quantity</label>
            <input type="number" min="0" value={qty} onChange={(e) => setQty(Math.max(0, parseInt(e.target.value) || 0))} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1" />
          </div>
          <div className="flex-1">
            <label className="text-xs font-medium text-[#9CA3AF]">Price (₦)</label>
            <input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1" />
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-sm font-medium text-[#374151]">Cancel</button>
          <button disabled={!name.trim()} onClick={() => onSave(name.trim(), qty, parseFloat(price) || 0, brand.trim())} style={{ background: BLUE }} className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-40">Add item</button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// Bin card — quantity changes commit immediately; history is downloadable
// ============================================================
function BinCard({ shop, cat, item, updateShop, logActivity, actingAs, onClose, showToast, permissions }) {
  const [price, setPrice] = useState(item.price);
  const [brand, setBrand] = useState(item.brand || "");
  const [inAmt, setInAmt] = useState("");
  const [outAmt, setOutAmt] = useState("");
  const [flash, setFlash] = useState("");
  const canIn = !permissions || permissions.canStockIn;
  const canOut = !permissions || permissions.canStockOut;

  function commitQtyChange(type, qtyChange, note) {
    if (!qtyChange) return;
    updateShop(shop.id, (s) => {
      let logType = null, logMsg = null;
      const next = {
        ...s,
        categories: s.categories.map((c) => {
          if (c.id !== cat.id) return c;
          return { ...c, items: c.items.map((it) => {
            if (it.id !== item.id) return it;
            const before = it.qty;
            const newQty = Math.max(0, before + qtyChange);
            const actualChange = newQty - before;
            if (actualChange === 0) return it;
            logType = actualChange > 0 ? "Stock increased" : "Stock decreased";
            logMsg = `${item.name}: ${before} → ${newQty}`;
            return { ...it, qty: newQty, history: [{ id: uid(), ts: now(), type, qtyChange: actualChange, newQty, actingAs, note }, ...(it.history || [])] };
          }) };
        }),
      };
      return logMsg ? withActivity(next, logType, logMsg, actingAs) : s;
    });
    setFlash(qtyChange > 0 ? `+${qtyChange} saved` : `${qtyChange} saved`);
    clearTimeout(commitQtyChange._t);
    commitQtyChange._t = setTimeout(() => setFlash(""), 1400);
  }
  function applyIn() { if (!canIn) return; const n = Math.floor(Number(inAmt)); if (!Number.isFinite(n) || n <= 0) return; commitQtyChange("IN", n, "Restock"); setInAmt(""); }
  function applyOut() { if (!canOut) return; const n = Math.floor(Number(outAmt)); if (!Number.isFinite(n) || n <= 0) return; commitQtyChange("OUT", -n, "Sold/used"); setOutAmt(""); }

  function saveDetails() {
    const parsedPrice = parseFloat(price) || 0;
    const priceChanged = parsedPrice !== item.price;
    const brandChanged = brand !== (item.brand || "");
    if (priceChanged || brandChanged) {
      updateShop(shop.id, (s) => {
        const next = { ...s, categories: s.categories.map((c) => c.id !== cat.id ? c : { ...c, items: c.items.map((it) => it.id !== item.id ? it : { ...it, price: parsedPrice, brand }) }) };
        return withActivity(next, "Item details updated", `${item.name}: price ${naira(item.price)} → ${naira(parsedPrice)}`, actingAs);
      });
    }
    onClose();
  }

  async function downloadItemHistory() {
    const rows = (item.history || []).map((h) => ({ date: fmtDate(h.ts), type: h.type, qtyChange: h.qtyChange, newQty: h.newQty ?? "", by: h.actingAs, note: h.note || "" }));
    if (rows.length === 0) { showToast?.("No history yet for this item"); return; }
    const csv = toCSV(rows, [
      { key: "date", label: "Date" }, { key: "type", label: "Type" }, { key: "qtyChange", label: "Qty Change" },
      { key: "newQty", label: "New Qty" }, { key: "by", label: "By" }, { key: "note", label: "Note" },
    ]);
    const blob = new Blob([csv], { type: "text/csv" });
    await exportFile(blob, `history-${shop.name}-${item.name}.csv`, "text/csv", showToast);
  }

  return (
    <Modal wide>
      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-bold text-lg text-[#111827]">{item.name}</h3>
            <p className="text-xs text-[#9CA3AF]">{cat.name}</p>
          </div>
          <button onClick={saveDetails}><XIcon size={18} className="text-[#9CA3AF]" /></button>
        </div>

        <div className="bg-[#F5F7FA] rounded-xl p-3 flex items-center justify-between mb-1">
          <span className="text-sm text-[#6B7280]">Current quantity</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => commitQtyChange("OUT", -1, "Manual adjustment")} disabled={!canOut} className="w-8 h-8 rounded-lg bg-white border border-[#E4E7EC] flex items-center justify-center active:bg-[#F1F3F6] disabled:opacity-30"><Minus size={14} /></button>
            <span className="w-10 text-center font-bold tabular-nums">{item.qty}</span>
            <button type="button" onClick={() => commitQtyChange("IN", 1, "Manual adjustment")} disabled={!canIn} className="w-8 h-8 rounded-lg bg-white border border-[#E4E7EC] flex items-center justify-center active:bg-[#F1F3F6] disabled:opacity-30"><Plus size={14} /></button>
          </div>
        </div>
        <div className="h-4 mb-3">{flash && <p className="text-[11px] font-semibold text-[#1B9C4B]">{flash}</p>}</div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="border border-[#CFEBD8] bg-[#F1FAF4] rounded-xl p-3" style={!canIn ? { opacity: 0.5 } : {}}>
            <label className="text-xs font-semibold text-[#1B9C4B]">Stock IN (restock)</label>
            <div className="flex gap-2 mt-2">
              <input type="number" min="1" inputMode="numeric" value={inAmt} onChange={(e) => setInAmt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyIn()} placeholder="0" disabled={!canIn} className="w-full border border-[#CFEBD8] rounded-lg px-2 py-1.5 text-sm disabled:bg-white" />
              <button type="button" onClick={applyIn} disabled={!canIn} className="px-3 rounded-lg bg-[#1B9C4B] text-white text-xs font-semibold shrink-0 disabled:opacity-60">Add</button>
            </div>
            <p className="text-[10px] text-[#1B9C4B] mt-1">{canIn ? "Saves immediately" : "Turned off for your account"}</p>
          </div>
          <div className="border border-[#F5D2CF] bg-[#FDF1F0] rounded-xl p-3" style={!canOut ? { opacity: 0.5 } : {}}>
            <label className="text-xs font-semibold text-[#C42E27]">Stock OUT (sold/used)</label>
            <div className="flex gap-2 mt-2">
              <input type="number" min="1" inputMode="numeric" value={outAmt} onChange={(e) => setOutAmt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyOut()} placeholder="0" disabled={!canOut} className="w-full border border-[#F5D2CF] rounded-lg px-2 py-1.5 text-sm disabled:bg-white" />
              <button type="button" onClick={applyOut} disabled={!canOut} className="px-3 rounded-lg bg-[#C42E27] text-white text-xs font-semibold shrink-0 disabled:opacity-60">Remove</button>
            </div>
            <p className="text-[10px] text-[#C42E27] mt-1">{canOut ? "Saves immediately" : "Turned off for your account"}</p>
          </div>
        </div>


        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="text-xs font-medium text-[#9CA3AF]">Price (₦)</label>
            <input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1" />
          </div>
          <div>
            <label className="text-xs font-medium text-[#9CA3AF] flex items-center gap-1"><Tag size={11} /> Brand</label>
            <input value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1" placeholder="Optional" />
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-[#9CA3AF] flex items-center gap-1"><Clock size={12} /> Recent history</h4>
            <button onClick={downloadItemHistory} className="text-xs font-semibold flex items-center gap-1" style={{ color: BLUE }}><Download size={12} /> Download</button>
          </div>
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {(item.history || []).slice(0, 12).map((h, i) => (
              <div key={h.id || i} className="flex items-center justify-between text-xs py-1 border-b border-[#F1F3F6] last:border-0">
                <span className={`font-semibold ${h.type === "IN" ? "text-[#1B9C4B]" : "text-[#C42E27]"}`}>{h.qtyChange > 0 ? "+" : ""}{h.qtyChange} {h.type}</span>
                <span className="text-[#9CA3AF]">{h.actingAs}</span>
                <span className="text-[#9CA3AF]">{fmtDate(h.ts)}</span>
              </div>
            ))}
            {(item.history || []).length === 0 && <p className="text-xs text-[#C9CDD6]">No history yet.</p>}
          </div>
        </div>

        <button type="button" onClick={saveDetails} style={{ background: BLUE }} className="w-full py-3 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2"><Check size={15} /> Save & Close</button>
      </div>
    </Modal>
  );
}

// ============================================================
// AI Setup (Shop Swap) — live API if a key is set, else local templates
// ============================================================
function ShopSwap({ shop, shops, createShop, updateShop, setActiveShopId, showToast }) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [error, setError] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  const [applyMode, setApplyMode] = useState("new");
  const [usedLocal, setUsedLocal] = useState(false);

  async function runSuggest() {
    if (!query.trim()) return;
    setLoading(true); setError(""); setSuggestions(null); setUsedLocal(false);
    let apiKey = "";
    try { const r = await storage.get(API_KEY_STORAGE); apiKey = JSON.parse(r.value).key || ""; } catch {}

    if (!apiKey) {
      setSuggestions(localSuggestCategories(query.trim()));
      setUsedLocal(true);
      setLoading(false);
      return;
    }

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1000,
          messages: [{ role: "user", content: `A shop owner runs a "${query.trim()}" business in Nigeria. Suggest 5-8 realistic stock categories for this exact business type.
Use plain, natural, shop-appropriate wording for what's stocked (e.g. "provisions", "tools", "spare parts") — never generic or clinical/pharmacy-style words like "drug" unless the shop is literally a pharmacy.
Respond with ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{"categories":[{"name":"string","description":"one short natural-language sentence"}]}` }],
        }),
      });
      if (!resp.ok) throw new Error("api error " + resp.status);
      const data = await resp.json();
      const text = data.content?.find((b) => b.type === "text")?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!parsed.categories?.length) throw new Error("empty");
      setSuggestions(parsed.categories);
    } catch (e) {
      setSuggestions(localSuggestCategories(query.trim()));
      setUsedLocal(true);
      setError("Live AI call failed (check your API key or connection) — showing built-in suggestions instead.");
    } finally { setLoading(false); }
  }

  function applySuggestions() {
    if (!suggestions) return;
    const newCats = suggestions.map((c) => ({ id: uid(), name: c.name, description: c.description, items: [] }));
    if (applyMode === "new") {
      const s = defaultShop(query.trim().replace(/\b\w/g, (c) => c.toUpperCase()));
      s.categories = newCats;
      createShop(s);
      setActiveShopId(s.id);
      showToast(`${s.name} created with ${newCats.length} categories`);
    } else {
      updateShop(shop.id, (sh) => ({ ...sh, categories: [...sh.categories, ...newCats] }));
      showToast(`Added ${newCats.length} categories to ${shop.name}`);
    }
    setConfirmApply(false); setSuggestions(null); setQuery("");
  }

  return (
    <div className="bg-white border border-[#E4E7EC] rounded-2xl p-3">
      <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: BLUE_BG }}>
        <Zap size={15} style={{ color: BLUE }} className="shrink-0" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSuggest()} placeholder="AI Setup — type your business type" className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-[#8AA0E8]" style={{ color: BLUE_DARK }} />
        <button onClick={runSuggest} disabled={loading || !query.trim()} className="flex items-center gap-1 text-xs font-bold shrink-0 disabled:opacity-40" style={{ color: BLUE }}><Search size={13} /> {loading ? "…" : "Suggest"}</button>
      </div>
      {error && <p className="text-xs text-[#B8710E] mt-2 px-1">{error}</p>}
      {usedLocal && !error && <p className="text-xs text-[#9CA3AF] mt-2 px-1">Using built-in suggestions (no API key set — tap "AI Setup key" at the top to add one).</p>}

      {suggestions && (
        <div className="mt-3 space-y-2">
          {suggestions.map((c, i) => (
            <div key={i} className="bg-[#F5F7FA] rounded-xl px-3 py-2">
              <div className="text-sm font-semibold text-[#111827]">{c.name}</div>
              <div className="text-xs text-[#6B7280]">{c.description}</div>
            </div>
          ))}
          <button onClick={() => { setApplyMode("new"); setConfirmApply(true); }} style={{ background: BLUE }} className="w-full py-2.5 rounded-xl text-white text-sm font-semibold mt-2">Create new shop from these categories</button>
          {shop.categories.length === 0 && <button onClick={() => { setApplyMode("current"); setConfirmApply(true); }} className="w-full py-2.5 rounded-xl border text-sm font-semibold" style={{ borderColor: BLUE, color: BLUE }}>Add to current empty shop "{shop.name}" instead</button>}
        </div>
      )}

      {confirmApply && (
        <ConfirmModal
          title={applyMode === "new" ? "Create a new shop?" : `Add categories to "${shop.name}"?`}
          body={applyMode === "new" ? "This creates a brand-new shop with these suggested categories. Your existing shops and their data are never overwritten or touched." : `This adds ${suggestions.length} new categories to "${shop.name}". Nothing existing will be changed or removed.`}
          confirmLabel="Yes, apply"
          onConfirm={applySuggestions}
          onCancel={() => setConfirmApply(false)}
        />
      )}
    </div>
  );
}

// ============================================================
// Admin
// ============================================================
function AdminTab({ shop, updateShop, showToast }) {
  const [unlocked, setUnlocked] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwInput2, setPwInput2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const hasPassword = !!shop.adminPasswordHash;

  async function setPassword() {
    setErr("");
    if (pwInput.length < 6) { setErr("Use at least 6 characters."); return; }
    if (pwInput !== pwInput2) { setErr("Passwords don't match."); return; }
    setBusy(true);
    try {
      const hash = await sha256(pwInput);
      updateShop(shop.id, (s) => ({ ...s, adminPasswordHash: hash }));
      setUnlocked(true);
    } catch { setErr("Couldn't save the password just now — please try again."); }
    finally { setBusy(false); }
  }
  async function login() {
    setErr(""); setBusy(true);
    try {
      const attempt = await sha256(pwInput);
      if (attempt === shop.adminPasswordHash) setUnlocked(true); else setErr("Incorrect password.");
    } catch { setErr("Incorrect password."); }
    finally { setBusy(false); }
  }
  function submit() { if (!busy) (hasPassword ? login() : setPassword()); }

  if (!unlocked) {
    return (
      <div className="max-w-sm mx-auto mt-10 text-center">
        <div className="w-14 h-14 rounded-full mx-auto mb-3 flex items-center justify-center" style={{ background: BLUE_BG }}><Lock size={24} style={{ color: BLUE }} /></div>
        <h3 className="font-bold text-[#111827] mb-1">{hasPassword ? "Admin login" : "Set an admin password"}</h3>
        <p className="text-xs text-[#9CA3AF] mb-4">{hasPassword ? "Enter your password to view admin tools. This is the same password on every phone." : "This password guards owner-only tools and is shared across every phone on your team. It's hashed (SHA-256) before it's stored."}</p>
        <input autoFocus type="password" value={pwInput} onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && hasPassword && submit()} placeholder="Password" className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-2" />
        {!hasPassword && <input type="password" value={pwInput2} onChange={(e) => setPwInput2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Confirm password" className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-2" />}
        {err && <p className="text-xs text-[#C42E27] mb-2">{err}</p>}
        <button type="button" onClick={submit} disabled={busy} style={{ background: BLUE }} className="w-full py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-60">{busy ? "Please wait…" : hasPassword ? "Unlock" : "Set password & continue"}</button>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <SectionHeader avatarText={AVATAR_INITIALS} title="Admin" subtitle="Manage team & view activity" />
      <ResellersPanel shop={shop} updateShop={updateShop} showToast={showToast} />
      <RetentionPanel shop={shop} updateShop={updateShop} />
      <ActivityPanel shop={shop} showToast={showToast} />
    </div>
  );
}

function ResellersPanel({ shop, updateShop, showToast }) {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", shopAddress: "", email: "" });
  const [del, setDel] = useState(null);

  function addRep() {
    if (!form.name.trim() || !form.email.trim()) return;
    const code = genCode();
    const rep = { id: uid(), ...form, code, activated: false, addedAt: now(), permissions: { ...DEFAULT_PERMS } };
    updateShop(shop.id, (s) => ({ ...s, reps: [...s.reps, rep] }));
    setShowAdd(false); setForm({ name: "", phone: "", shopAddress: "", email: "" });
    showToast(`${rep.name} added — share their connection code`);
  }
  function copyCode(rep) { copyText(rep.code, showToast); }
  function togglePermission(rep, key) {
    updateShop(shop.id, (s) => ({
      ...s,
      reps: s.reps.map((r) => r.id !== rep.id ? r : { ...r, permissions: { ...repPerms(r), [key]: !repPerms(r)[key] } }),
    }));
  }

  return (
    <div>
      <SectionHeader title="Resellers" subtitle="People who record sales under their own name" action={<PillButton icon={UserPlus} onClick={() => setShowAdd(true)}>Add Reseller</PillButton>} />
      {shop.reps.length === 0 ? (
        <div className="bg-white border border-[#E4E7EC] rounded-2xl py-10 px-6 text-center">
          <div className="w-12 h-12 rounded-full mx-auto mb-3 flex items-center justify-center bg-[#F1F3F6]"><UserPlus size={20} className="text-[#9CA3AF]" /></div>
          <p className="font-bold text-[#111827] mb-1">No resellers yet</p>
          <p className="text-xs text-[#9CA3AF] mb-4">Add a reseller to give them their own connection code</p>
          <button onClick={() => setShowAdd(true)} style={{ background: BLUE }} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-white text-sm font-semibold"><Plus size={15} /> Add First Reseller</button>
        </div>
      ) : (
        <div className="space-y-2">
          {shop.reps.map((r) => {
            const perms = repPerms(r);
            return (
            <div key={r.id} className="bg-white border border-[#E4E7EC] rounded-xl p-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm font-semibold text-[#111827]">{r.name}</div>
                  <div className="text-xs text-[#9CA3AF]">{r.phone} · {r.shopAddress}</div>
                  <div className="text-xs text-[#9CA3AF]">{r.email}</div>
                </div>
                <button onClick={() => setDel(r)} className="text-[#9CA3AF]"><Trash2 size={14} /></button>
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={r.activated ? { background: "#E7F8ED", color: "#1B9C4B" } : { background: BLUE_BG, color: BLUE }}>{r.activated ? "Active reseller" : "Awaiting signup"}</span>
                {!r.activated && <button onClick={() => copyCode(r)} className="text-xs font-mono font-bold flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#F5F7FA]" style={{ color: BLUE }}><Copy size={11} /> {r.code}</button>}
              </div>
              <p className="text-[10px] font-semibold text-[#9CA3AF] mt-3 mb-1.5">Permissions</p>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => togglePermission(r, "canStockIn")} className="text-[10px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1" style={perms.canStockIn ? { background: "#E7F8ED", color: "#1B9C4B" } : { background: "#FDEAEA", color: "#C42E27" }}>
                  {perms.canStockIn ? <Check size={9} /> : <XIcon size={9} />} Can restock (IN)
                </button>
                <button onClick={() => togglePermission(r, "canStockOut")} className="text-[10px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1" style={perms.canStockOut ? { background: "#E7F8ED", color: "#1B9C4B" } : { background: "#FDEAEA", color: "#C42E27" }}>
                  {perms.canStockOut ? <Check size={9} /> : <XIcon size={9} />} Can record sales (OUT)
                </button>
              </div>
            </div>
          );})}
        </div>
      )}
      {showAdd && (
        <Modal>
          <div className="p-5">
            <h3 className="font-bold text-lg mb-3 text-[#111827]">Add reseller</h3>
            <label className="text-xs font-medium text-[#9CA3AF]">Name</label>
            <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-3" />
            <label className="text-xs font-medium text-[#9CA3AF]">Phone number</label>
            <input value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-3" />
            <label className="text-xs font-medium text-[#9CA3AF]">Shop address</label>
            <input value={form.shopAddress} onChange={(e) => setForm((p) => ({ ...p, shopAddress: e.target.value }))} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-3" />
            <label className="text-xs font-medium text-[#9CA3AF]">Email address</label>
            <input value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mt-1 mb-3" />
            <div className="flex gap-2 mt-2">
              <button onClick={() => setShowAdd(false)} className="flex-1 py-2.5 rounded-xl border border-[#E4E7EC] text-sm font-medium text-[#374151]">Cancel</button>
              <button onClick={addRep} style={{ background: BLUE }} className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold">Add & generate code</button>
            </div>
          </div>
        </Modal>
      )}
      {del && <ConfirmModal title={`Remove ${del.name}?`} body="They'll lose access. An unused code will stop working; an already-activated login will be disabled." confirmLabel="Remove" danger onConfirm={() => { updateShop(shop.id, (s) => ({ ...s, reps: s.reps.filter((r) => r.id !== del.id) })); setDel(null); }} onCancel={() => setDel(null)} />}
    </div>
  );
}

function RetentionPanel({ shop, updateShop }) {
  const options = [7, 30, 90, 365, "forever"];
  return (
    <div>
      <SectionHeader title="History Retention" subtitle="Older stock-change history clears automatically after this many days" />
      <div className="flex gap-2 flex-wrap">
        {options.map((o) => (
          <button key={o} onClick={() => updateShop(shop.id, (s) => ({ ...s, historyRetentionDays: o }))} className="px-3 py-1.5 rounded-full text-xs font-semibold" style={shop.historyRetentionDays === o ? { background: BLUE, color: "white" } : { background: "white", border: "1px solid #E4E7EC", color: "#374151" }}>{o === "forever" ? "Forever" : `${o} days`}</button>
        ))}
      </div>
    </div>
  );
}

function ActivityPanel({ shop, showToast }) {
  async function downloadActivityLog() {
    const rows = (shop.activityLog || []).map((a) => ({ date: fmtDate(a.ts), action: a.action, details: a.details, by: a.actingAs }));
    if (rows.length === 0) { showToast?.("No activity yet"); return; }
    const csv = toCSV(rows, [{ key: "date", label: "Date" }, { key: "action", label: "Action" }, { key: "details", label: "Details" }, { key: "by", label: "By" }]);
    const blob = new Blob([csv], { type: "text/csv" });
    await exportFile(blob, `activity-log-${shop.name}.csv`, "text/csv", showToast);
  }
  return (
    <div>
      <SectionHeader title="Activity Log" subtitle="All stock changes for this shop, most recent first" action={<PillButton icon={Download} variant="outline" onClick={downloadActivityLog}>Download</PillButton>} />
      <div className="space-y-1.5 max-h-96 overflow-y-auto">
        {(shop.activityLog || []).map((a) => {
          const isIncrease = a.action.toLowerCase().includes("increased");
          const isDecrease = a.action.toLowerCase().includes("decreased");
          const color = isIncrease ? "#1B9C4B" : isDecrease ? "#C42E27" : "#111827";
          return (
          <div key={a.id} className="bg-white border border-[#E4E7EC] rounded-xl px-3 py-2 text-xs">
            <div className="flex justify-between"><span className="font-semibold" style={{ color }}>{a.action}</span><span className="text-[#9CA3AF]">{fmtDate(a.ts)}</span></div>
            <div className="text-[#6B7280] mt-0.5">{a.details}</div>
            <div className="text-[#C9CDD6] mt-0.5">by {a.actingAs}</div>
          </div>
        );})}
        {(!shop.activityLog || shop.activityLog.length === 0) && <div className="bg-white border border-[#E4E7EC] rounded-2xl py-8 text-center"><p className="text-xs text-[#9CA3AF]">No activity yet.</p></div>}
      </div>
    </div>
  );
}

// ============================================================
// Statement
// ============================================================
const PRESETS = [{ id: "today", label: "Today" }, { id: "7", label: "Last 7 days" }, { id: "30", label: "Last 30 days" }, { id: "90", label: "Last 90 days" }, { id: "custom", label: "Custom range" }];
function presetRange(id) {
  const end = new Date();
  let start = new Date();
  if (id === "today") start.setHours(0, 0, 0, 0);
  else if (id === "7") start = new Date(end.getTime() - 7 * 86400000);
  else if (id === "30") start = new Date(end.getTime() - 30 * 86400000);
  else if (id === "90") start = new Date(end.getTime() - 90 * 86400000);
  return { start: toLocalInput(start), end: toLocalInput(end) };
}
function toLocalInput(d) { const pad = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function toDDMM(v) { if (!v) return ""; const d = new Date(v); const pad = (n) => String(n).padStart(2, "0"); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }

function StatementTab({ shop, showToast }) {
  const [preset, setPreset] = useState("30");
  const [start, setStart] = useState(() => presetRange("30").start);
  const [end, setEnd] = useState(() => presetRange("30").end);
  const [email, setEmail] = useState("");
  const notify = showToast || (() => {});

  function choosePreset(id) { setPreset(id); if (id !== "custom") { const r = presetRange(id); setStart(r.start); setEnd(r.end); } }

  // History is always derived live from the current shop data and date range —
  // no button press required before it's visible. It also updates automatically
  // if a reseller records a change elsewhere while you're looking at this tab.
  const rows = useMemo(() => {
    if (!start || !end) return [];
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    const out = [];
    shop.categories.forEach((cat) => { cat.items.forEach((item) => { (item.history || []).forEach((h) => { const t = new Date(h.ts).getTime(); if (t >= s && t <= e) out.push({ date: fmtDate(h.ts), category: cat.name, item: item.name, type: h.type, change: h.qtyChange, newQty: h.newQty, actingAs: h.actingAs, price: item.price }); }); }); });
    out.sort((a, b) => new Date(b.date) - new Date(a.date));
    return out;
  }, [shop, start, end]);

  function csvText() { return toCSV(rows, [{ key: "date", label: "Date" }, { key: "category", label: "Category" }, { key: "item", label: "Item" }, { key: "type", label: "Type" }, { key: "change", label: "Qty Change" }, { key: "newQty", label: "New Qty" }, { key: "actingAs", label: "By" }, { key: "price", label: "Price" }]); }

  async function downloadCSV() { if (!rows.length) return; const blob = new Blob([csvText()], { type: "text/csv" }); await exportFile(blob, `statement-${shop.name}.csv`, "text/csv", notify); }
  async function downloadXLSX() {
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows.map((r) => ({ Date: r.date, Category: r.category, Item: r.item, Type: r.type, "Qty Change": r.change, "New Qty": r.newQty, By: r.actingAs, Price: r.price })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    const arrayBuf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([arrayBuf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await exportFile(blob, `statement-${shop.name}.xlsx`, blob.type, notify);
  }
  async function downloadJPEG() {
    if (!rows.length) return;
    const rowH = 24, padTop = 70, colW = [150, 110, 130, 60, 80, 70, 90];
    const canvas = document.createElement("canvas");
    canvas.width = 720; canvas.height = padTop + rowH * (rows.length + 1) + 30;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111827"; ctx.font = "bold 18px sans-serif";
    ctx.fillText(`${shop.name} — Statement`, 20, 30);
    ctx.font = "11px sans-serif"; ctx.fillStyle = "#6B7280";
    ctx.fillText(`${toDDMM(start)} to ${toDDMM(end)}`, 20, 50);
    const headers = ["Date", "Category", "Item", "Type", "Change", "New Qty", "By"];
    let x = 20, y = padTop;
    ctx.font = "bold 11px sans-serif"; ctx.fillStyle = "#111827";
    headers.forEach((h, i) => { ctx.fillText(h, x, y); x += colW[i]; });
    y += 8;
    ctx.strokeStyle = "#E4E7EC"; ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(700, y); ctx.stroke();
    ctx.font = "10px sans-serif";
    rows.forEach((r) => {
      y += rowH; x = 20;
      const vals = [r.date, r.category, r.item, r.type, String(r.change), String(r.newQty ?? ""), r.actingAs];
      const color = r.type === "IN" ? "#1B9C4B" : "#C42E27";
      vals.forEach((v, i) => { ctx.fillStyle = (i === 3 || i === 4) ? color : "#111827"; ctx.fillText(String(v).slice(0, 18), x, y); x += colW[i]; });
    });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) { notify("Couldn't generate the image."); return; }
    await exportFile(blob, `statement-${shop.name}.jpg`, "image/jpeg", notify);
  }
  function statementHTML() {
    const rowsHtml = rows.map((r) => {
      const color = r.type === "IN" ? "#1B9C4B" : "#C42E27";
      return `<tr><td>${r.date}</td><td>${r.category}</td><td>${r.item}</td><td style="color:${color};font-weight:600">${r.type}</td><td style="color:${color};font-weight:600">${r.change}</td><td>${r.newQty ?? ""}</td><td>${r.actingAs}</td><td>${naira(r.price)}</td></tr>`;
    }).join("");
    return `<html><head><title>Statement - ${shop.name}</title><style>body{font-family:sans-serif;padding:24px;color:#111827}h1{font-size:18px}p{color:#6B7280;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #E4E7EC;font-size:11px}</style></head><body><h1>${shop.name} — Statement</h1><p>${toDDMM(start)} to ${toDDMM(end)}</p><table><thead><tr><th>Date</th><th>Category</th><th>Item</th><th>Type</th><th>Change</th><th>New Qty</th><th>By</th><th>Price</th></tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`;
  }
  async function downloadPDF() {
    if (!rows.length) return;
    const html = statementHTML();
    let opened = null;
    try { opened = window.open("", "_blank"); } catch (e) { opened = null; }
    if (opened) { opened.document.write(html); opened.document.close(); notify("Opened a printable page — use Print › Save as PDF"); setTimeout(() => { try { opened.print(); } catch (e) {} }, 300); }
    else { const blob = new Blob([html], { type: "text/html" }); await exportFile(blob, `statement-${shop.name}.html`, "text/html", notify); notify("Saved as a printable page — open it and use Print › Save as PDF"); }
  }
  async function copyCSV() { if (!rows.length) return; await copyText(csvText(), notify); }

  return (
    <div className="space-y-5">
      <SectionHeader avatarText={AVATAR_INITIALS} title="History & Statement" subtitle="Updates live — no need to generate anything first" />
      <div className="bg-white border border-[#E4E7EC] rounded-2xl p-4">
        <label className="text-xs font-semibold text-[#374151] mb-2 block">Date range</label>
        <div className="flex flex-wrap gap-2 mb-3">
          {PRESETS.map((p) => <button key={p.id} onClick={() => choosePreset(p.id)} className="px-3.5 py-2 rounded-xl text-sm font-medium" style={preset === p.id ? { background: BLUE, color: "white" } : { background: "#F1F3F6", color: "#374151" }}>{p.label}</button>)}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1"><input type="datetime-local" value={start} disabled={preset !== "custom"} onChange={(e) => setStart(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm disabled:bg-[#F5F7FA] disabled:text-[#6B7280]" /></div>
          <span className="text-[#9CA3AF] text-sm">to</span>
          <div className="flex-1"><input type="datetime-local" value={end} disabled={preset !== "custom"} onChange={(e) => setEnd(e.target.value)} className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm disabled:bg-[#F5F7FA] disabled:text-[#6B7280]" /></div>
        </div>
      </div>

      <div className="bg-white border border-[#E4E7EC] rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3"><h4 className="font-semibold text-[#111827] text-sm">{rows.length} {rows.length === 1 ? "entry" : "entries"}</h4></div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button onClick={downloadCSV} disabled={!rows.length} className="py-2 rounded-lg border border-[#E4E7EC] text-xs font-medium flex items-center justify-center gap-1 disabled:opacity-40"><Download size={12} /> CSV</button>
          <button onClick={downloadXLSX} disabled={!rows.length} className="py-2 rounded-lg border border-[#E4E7EC] text-xs font-medium flex items-center justify-center gap-1 disabled:opacity-40"><Download size={12} /> Excel</button>
          <button onClick={downloadJPEG} disabled={!rows.length} className="py-2 rounded-lg border border-[#E4E7EC] text-xs font-medium flex items-center justify-center gap-1 disabled:opacity-40"><Download size={12} /> JPEG</button>
          <button onClick={downloadPDF} disabled={!rows.length} className="py-2 rounded-lg border border-[#E4E7EC] text-xs font-medium flex items-center justify-center gap-1 disabled:opacity-40"><Download size={12} /> PDF</button>
        </div>
        <button onClick={copyCSV} disabled={!rows.length} className="w-full py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1 disabled:opacity-40" style={{ color: BLUE }}><Copy size={12} /> Copy as text (works even if downloads don't)</button>
        <div className="max-h-72 overflow-y-auto text-xs mt-3">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-[#F1F3F6] gap-2">
              <div className="min-w-0">
                <div className="text-[#111827] font-medium truncate">{r.item}</div>
                <div className="text-[#9CA3AF] text-[10px]">{r.date} · {r.actingAs}</div>
              </div>
              <span className="font-bold shrink-0" style={{ color: r.type === "IN" ? "#1B9C4B" : "#C42E27" }}>{r.change > 0 ? "+" : ""}{r.change} {r.type}</span>
            </div>
          ))}
          {rows.length === 0 && <p className="text-[#9CA3AF] py-2">No activity in this range.</p>}
        </div>
      </div>

      <div className="bg-white border border-[#E4E7EC] rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-1"><Mail size={15} style={{ color: BLUE }} /><h3 className="font-bold text-[#111827] text-sm">Email Statement</h3></div>
        <p className="text-xs text-[#9CA3AF] mb-3">This app has no email server of its own, so this downloads a CSV you can attach to an email yourself.</p>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" className="w-full border border-[#E4E7EC] rounded-xl px-3 py-2.5 text-sm mb-3" />
        <button disabled={!email.trim() || !rows.length} onClick={downloadCSV} style={{ background: BLUE }} className="w-full py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-40">Prepare CSV to attach</button>
      </div>
    </div>
  );
}

// ============================================================
// Mount
// ============================================================
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
