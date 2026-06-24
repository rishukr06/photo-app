import { useState, useEffect, useCallback, useRef } from "react";
import {
  Cloud,
  Image as ImageIcon,
  UploadCloud,
  Camera,
  Settings,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Info,
  X,
} from "lucide-react";
import { listS3Objects, checkCorsSufficient, applyRequiredCors, uploadS3FileWithProgress } from "./utils/s3";
import { warmDuckDB } from "./utils/duckdb";
import type { S3Credentials, S3MediaItem } from "./utils/s3";
import { loadMetaIndex, clearMetaIndexCache, batchUpsertMetaEntries } from "./utils/metaIndex";
import type { MetaIndex, MetaEntry } from "./utils/metaIndex";
import {
  getCachedList,
  setCachedList,
  clearCachedList,
  clearUrlCache,
  getListCacheAge,
  pruneUrlCache,
} from "./utils/cache";
import { reverseGeocode } from "./utils/geocode";
import * as exifr from "exifr";
import { SetupWizard } from "./components/SetupWizard";
import { BulkUploader } from "./components/BulkUploader";
import { GalleryGrid } from "./components/GalleryGrid";
import { UserGuide } from "./components/UserGuide";
import { SettingsPage } from "./components/SettingsPage";

interface Toast {
  id: string;
  message: string;
  type: "success" | "info" | "warning" | "danger";
}

function App() {
  const [creds, setCreds] = useState<S3Credentials | null>(null);
  console.log("DEBUG: App render body executing. creds status:", creds ? "non-null" : "null");
  const [items, setItems] = useState<S3MediaItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"gallery" | "upload" | "settings">("gallery");
  const [prevTab, setPrevTab] = useState<"gallery" | "upload">("gallery");
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [initialized, setInitialized] = useState<boolean>(false);
  const [cacheAgeMs, setCacheAgeMs] = useState<number | null>(null);
  const [corsOk, setCorsOk] = useState<boolean | null>(null);
  const [fixingCors, setFixingCors] = useState(false);
  const [metaIndex, setMetaIndex] = useState<MetaIndex>({});
  const [isGuideOpen, setIsGuideOpen] = useState<boolean>(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("s3store_theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  // Apply theme to document element
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("s3store_theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === "light" ? "dark" : "light");
  };

  // Toast helper
  const showToast = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    
    // Auto-remove toast after 4 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Scan and load objects from S3, with optional cache bypass
  const refreshGallery = useCallback(async (
    currentCreds = creds,
    opts: { force?: boolean } = {}
  ) => {
    if (!currentCreds) return;

    // Serve from cache unless caller explicitly wants fresh data
    if (!opts.force) {
      const cached = getCachedList(currentCreds.bucketName);
      if (cached) {
        setItems(cached);
        setCacheAgeMs(getListCacheAge(currentCreds.bucketName));
        pruneUrlCache(currentCreds.bucketName);
        return;
      }
    }

    setLoading(true);
    try {
      const objects = await listS3Objects(currentCreds);
      setItems(objects);
      setCachedList(currentCreds.bucketName, objects);
      setCacheAgeMs(0);
      showToast(`Gallery synced · ${objects.length} files`, "success");
    } catch (err: any) {
      showToast(`Sync failed: ${err.message || "Check credentials and CORS config."}`, "danger");
    } finally {
      setLoading(false);
    }
  }, [creds, showToast]);

  // Check CORS and optionally report result — runs after connect and on demand
  const checkCors = useCallback(async (currentCreds: S3Credentials) => {
    const ok = await checkCorsSufficient(currentCreds);
    setCorsOk(ok);
    return ok;
  }, []);

  const reloadMetaIndex = useCallback(async (currentCreds: S3Credentials) => {
    try {
      const index = await loadMetaIndex(currentCreds);
      setMetaIndex(index);
    } catch {}
  }, []);

  // Called by GalleryGrid when it lazy-geocodes an existing photo in the lightbox.
  // Updates local state immediately + persists to S3 async.
  const handleMetaEnrich = useCallback((entries: Record<string, MetaEntry>) => {
    setMetaIndex(prev => ({ ...prev, ...entries }));
    if (creds) {
      batchUpsertMetaEntries(creds, entries).catch(console.warn);
    }
  }, [creds]);

  // Upload a photo/video captured via the native camera input
  const handleCameraCapture = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so same file can re-trigger
    if (!file || !creds) return;

    showToast("Uploading photo…", "info");
    try {
      // Read EXIF from the captured image
      let gpsLat: string | undefined;
      let gpsLng: string | undefined;
      let dateTaken: string | undefined;
      try {
        const exif = await exifr.parse(file, { gps: true, tiff: true });
        if (exif?.latitude != null) gpsLat = String(exif.latitude);
        if (exif?.longitude != null) gpsLng = String(exif.longitude);
        if (exif?.DateTimeOriginal) dateTaken = new Date(exif.DateTimeOriginal).toISOString();
      } catch { /* EXIF not available — fine */ }

      const now = new Date().toISOString();
      const destKey = `${creds.prefix ?? ""}${file.name}`;
      const meta: Record<string, string> = {
        "original-name": file.name,
        "date-taken": dateTaken ?? now,
        "file-date": now,
      };
      if (gpsLat) { meta["gps-lat"] = gpsLat; meta["gps-lng"] = gpsLng!; }

      await uploadS3FileWithProgress(creds, file, destKey, () => {}, meta);

      const entry: MetaEntry = { dateTaken: dateTaken ?? now };
      if (gpsLat && gpsLng) {
        entry.gpsLat = gpsLat;
        entry.gpsLng = gpsLng;
        try {
          const geo = await reverseGeocode(gpsLat, gpsLng);
          if (geo.city)        entry.city        = geo.city;
          if (geo.country)     entry.country     = geo.country;
          if (geo.countryCode) entry.countryCode = geo.countryCode;
          if (geo.area)        entry.area        = geo.area;
          if (geo.street)      entry.street      = geo.street;
        } catch { /* geocoding optional */ }
      }
      await batchUpsertMetaEntries(creds, { [destKey]: entry });

      clearCachedList(creds.bucketName);
      clearMetaIndexCache(creds.bucketName);
      refreshGallery(creds, { force: true });
      reloadMetaIndex(creds);
      showToast("Photo saved to S3!", "success");
    } catch (err: any) {
      showToast(`Upload failed: ${err.message ?? err}`, "danger");
    }
  }, [creds, showToast, refreshGallery, reloadMetaIndex]);

  // Apply the correct CORS rule then re-check
  const handleFixCors = useCallback(async () => {
    if (!creds) return;
    setFixingCors(true);
    try {
      await applyRequiredCors(creds);
      const ok = await checkCorsSufficient(creds);
      setCorsOk(ok);
      if (ok) showToast("CORS updated — photo metadata will now load correctly.", "success");
      else showToast("CORS update applied but check failed. Verify manually.", "warning");
    } catch (err: any) {
      showToast(`CORS update failed: ${err.message || err}`, "danger");
    } finally {
      setFixingCors(false);
    }
  }, [creds, showToast]);

  // Handle successful connection setup — always fetch fresh on first connect
  const handleConnectionSuccess = (newCreds: S3Credentials) => {
    setCreds(newCreds);
    showToast("AWS S3 connected successfully!", "success");
    refreshGallery(newCreds, { force: true });
    checkCors(newCreds);
    reloadMetaIndex(newCreds);
  };

  // Disconnect & logout
  const handleDisconnect = () => {
    if (creds) {
      clearCachedList(creds.bucketName);
      clearUrlCache(creds.bucketName);
      clearMetaIndexCache(creds.bucketName);
    }
    setMetaIndex({});
    localStorage.removeItem("s3store_creds");
    setCreds(null);
    setItems([]);
    setCacheAgeMs(null);
    setCorsOk(null);
    setActiveTab("gallery");
    showToast("Disconnected from S3 bucket.", "info");
  };

  // Initial credentials check from localStorage
  useEffect(() => {
    warmDuckDB(); // start loading WASM in the background immediately
    console.log("DEBUG: App mount useEffect triggered");
    const saved = localStorage.getItem("s3store_creds");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as S3Credentials;
        console.log("DEBUG: App mount useEffect found saved credentials, calling setCreds and refreshGallery");
        setCreds(parsed);
        refreshGallery(parsed);
        checkCors(parsed);
        reloadMetaIndex(parsed);
      } catch (e) {
        console.error("Error reading initial credentials", e);
      }
    }
    setInitialized(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!initialized) {
    return (
      <div style={styles.appLoader}>
        <div className="pulse" style={{ fontSize: "2rem", color: "var(--color-primary)" }}>● ● ●</div>
      </div>
    );
  }

  return (
    <div style={styles.appContainer}>
      {/* Top Header */}
      <header className="header-container glass-panel">
        <div className="header-inner">
          {/* Logo */}
          <div className="header-logo-group">
            <div className="logo-icon">
              <Cloud size={15} color={theme === "light" ? "#fff" : "#07090E"} />
            </div>
            <h1 className="logo-text">S3Store</h1>
          </div>

          {/* Connection pill (desktop) */}
          {creds && (
            <div className="connection-pill">
              <span className="connection-dot" />
              <span className="connection-bucket-name" title={creds.bucketName}>
                {creds.bucketName}
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="header-actions">
            {creds && (
              <button
                className="btn btn-secondary header-refresh-btn"
                onClick={() => {
                  clearUrlCache(creds!.bucketName);
                  clearCachedList(creds!.bucketName);
                  refreshGallery(creds!, { force: true });
                }}
                disabled={loading}
              >
                <RefreshCw size={14} className={loading ? "pulse" : ""} />
                <span className="hide-mobile-effect">Refresh</span>
              </button>
            )}

            <button
              type="button"
              className={`btn btn-secondary btn-icon-only${activeTab === "settings" ? " btn-primary" : ""}`}
              onClick={() => {
                if (activeTab === "settings") {
                  setActiveTab(prevTab);
                } else {
                  if (activeTab !== "settings") setPrevTab(activeTab as "gallery" | "upload");
                  setActiveTab("settings");
                }
              }}
              title="Settings"
            >
              <Settings size={15} />
            </button>
          </div>
        </div>

        {/* Mobile-only connection status bar */}
        {creds && (
          <div className="header-mobile-status">
            <span className="connection-dot" />
            <span style={{ fontSize: "0.72rem", fontFamily: "var(--font-mono)", color: "var(--color-success)" }}>
              Connected · {creds.bucketName}
            </span>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main style={styles.mainContent}>
        {!creds ? (
          <SetupWizard onConnectionSuccess={handleConnectionSuccess} onOpenGuide={() => setIsGuideOpen(true)} />
        ) : (
          <div style={styles.dashboardContainer}>
            {/* Dashboard Tabs Navigation (Desktop Only) */}
            <div style={{ ...styles.tabNav, display: activeTab === "settings" ? "none" : undefined }} className="glass-panel desktop-nav">
              <div style={styles.tabButtons}>
                <button
                  style={{
                    ...styles.tabButton,
                    color: activeTab === "gallery" ? "var(--color-primary)" : "var(--text-muted)",
                    backgroundColor: activeTab === "gallery" ? "var(--color-primary-dim)" : "transparent",
                    borderColor: activeTab === "gallery" ? "var(--border-color-hover)" : "transparent",
                  }}
                  onClick={() => setActiveTab("gallery")}
                >
                  <ImageIcon size={15} />
                  <span>Gallery</span>
                  {items.length > 0 && <span style={styles.itemCountBadge}>{items.length}</span>}
                </button>

                <button
                  style={{ ...styles.tabButton, color: "var(--text-muted)" }}
                  onClick={() => cameraInputRef.current?.click()}
                  title="Take a photo"
                >
                  <Camera size={15} />
                  <span>Camera</span>
                </button>

                <button
                  style={{
                    ...styles.tabButton,
                    color: activeTab === "upload" ? "var(--color-primary)" : "var(--text-muted)",
                    backgroundColor: activeTab === "upload" ? "var(--color-primary-dim)" : "transparent",
                    borderColor: activeTab === "upload" ? "var(--border-color-hover)" : "transparent",
                  }}
                  onClick={() => setActiveTab("upload")}
                >
                  <UploadCloud size={15} />
                  <span>Upload</span>
                </button>
              </div>
            </div>

            {/* Mobile Bottom Tab Bar */}
            <nav className="mobile-bottom-nav">
              <div className="tab-buttons-container">
                <button
                  className={`mobile-bottom-nav-btn ${activeTab === "gallery" ? "active" : ""}`}
                  onClick={() => setActiveTab("gallery")}
                >
                  <ImageIcon size={18} />
                  <span>Gallery</span>
                </button>
                <button
                  className="mobile-bottom-nav-btn"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera size={18} />
                  <span>Camera</span>
                </button>
                <button
                  className={`mobile-bottom-nav-btn ${activeTab === "upload" ? "active" : ""}`}
                  onClick={() => setActiveTab("upload")}
                >
                  <UploadCloud size={18} />
                  <span>Upload</span>
                </button>
                <button
                  className={`mobile-bottom-nav-btn ${activeTab === "settings" ? "active" : ""}`}
                  onClick={() => {
                    if (activeTab !== "settings") setPrevTab(activeTab as "gallery" | "upload");
                    setActiveTab("settings");
                  }}
                >
                  <Settings size={18} />
                  <span>Settings</span>
                </button>
              </div>
            </nav>

            {/* CORS warning banner */}
            {corsOk === false && activeTab !== "settings" && (
              <div className="glass-panel" style={styles.corsBanner}>
                <AlertCircle size={16} color="var(--color-warning)" style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: "0.82rem" }}>
                  <strong>CORS config needs updating</strong> — photo metadata won't load until{" "}
                  <code style={styles.corsCode}>x-amz-meta-*</code> is added to ExposeHeaders.
                </span>
                <button
                  className="btn btn-primary"
                  style={{ flexShrink: 0, fontSize: "0.78rem", padding: "6px 14px" }}
                  onClick={handleFixCors}
                  disabled={fixingCors}
                >
                  {fixingCors ? "Fixing…" : "Fix automatically"}
                </button>
              </div>
            )}

            {/* Dashboard Tab Content */}
            <div className="animate-fade-in" style={{ width: "100%" }}>
              {activeTab === "settings" ? (
                <SettingsPage
                  theme={theme}
                  onToggleTheme={toggleTheme}
                  creds={creds}
                  onDisconnect={handleDisconnect}
                  onBack={() => setActiveTab(prevTab)}
                  onOpenGuide={() => { setActiveTab(prevTab); setIsGuideOpen(true); }}
                />
              ) : activeTab === "gallery" ? (
                <GalleryGrid
                  creds={creds}
                  items={items}
                  loading={loading}
                  cacheAgeMs={cacheAgeMs}
                  metaIndex={metaIndex}
                  onMetaEnrich={handleMetaEnrich}
                  onRefresh={() => {
                    clearUrlCache(creds.bucketName);
                    clearCachedList(creds.bucketName);
                    clearMetaIndexCache(creds.bucketName);
                    refreshGallery(creds, { force: true });
                    reloadMetaIndex(creds);
                  }}
                />
              ) : (
                <BulkUploader
                  creds={creds}
                  existingItems={items}
                  onUploadComplete={() => {
                    clearCachedList(creds.bucketName);
                    clearMetaIndexCache(creds.bucketName);
                    refreshGallery(creds, { force: true });
                    reloadMetaIndex(creds);
                  }}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer style={styles.footer}>
        <p>&copy; {new Date().getFullYear()} S3Store App. All operations run directly in your browser.</p>
      </footer>

      {/* Toast Notifications Overlay */}
      <div className="toast-container">
        {toasts.map(toast => {
          const isSuccess = toast.type === "success";
          const isDanger = toast.type === "danger";
          const isWarning = toast.type === "warning";
          
          return (
            <div key={toast.id} className={`toast ${toast.type}`}>
              {isSuccess && <CheckCircle size={18} color="var(--color-success)" style={{ flexShrink: 0, marginTop: "2px" }} />}
              {isDanger && <AlertCircle size={18} color="var(--color-danger)" style={{ flexShrink: 0, marginTop: "2px" }} />}
              {isWarning && <AlertCircle size={18} color="var(--color-warning)" style={{ flexShrink: 0, marginTop: "2px" }} />}
              {!isSuccess && !isDanger && !isWarning && <Info size={18} color="var(--color-primary)" style={{ flexShrink: 0, marginTop: "2px" }} />}
              
              <div style={{ flex: 1, fontSize: "0.85rem", lineHeight: "1.4" }}>{toast.message}</div>
              
              <button style={styles.toastCloseBtn} onClick={() => removeToast(toast.id)}>
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Hidden native camera input — triggered by Camera nav button */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={handleCameraCapture}
      />

      <UserGuide isOpen={isGuideOpen} onClose={() => setIsGuideOpen(false)} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  appLoader: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    height: "100vh",
    backgroundColor: "var(--bg-base)",
  },
  appContainer: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    padding: "20px 20px",
    maxWidth: "1280px",
    width: "100%",
    margin: "0 auto",
  },
  mainContent: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
  },
  dashboardContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    width: "100%",
  },
  tabNav: {
    padding: "5px",
    borderRadius: "var(--radius-md)",
    width: "fit-content",
  },
  tabButtons: {
    display: "flex",
    gap: "3px",
  },
  tabButton: {
    border: "1px solid transparent",
    padding: "8px 16px",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    fontSize: "0.82rem",
    fontWeight: "600",
    fontFamily: "var(--font-sans)",
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    transition: "all var(--transition-fast)",
    background: "transparent",
  },
  itemCountBadge: {
    fontSize: "0.68rem",
    background: "rgba(34, 211, 238, 0.12)",
    color: "var(--color-primary)",
    padding: "1px 6px",
    borderRadius: "4px",
    fontWeight: "600",
    border: "1px solid rgba(34, 211, 238, 0.18)",
  },
  footer: {
    marginTop: "48px",
    padding: "20px 0",
    textAlign: "center",
    borderTop: "1px solid var(--border-color)",
    color: "var(--text-muted)",
    fontSize: "0.78rem",
  },
  toastCloseBtn: {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "2px",
    marginLeft: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "4px",
    transition: "color var(--transition-fast)",
  },
  hideMobile: {},
  corsBanner: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 16px",
    borderRadius: "var(--radius-md)",
    border: "1px solid rgba(251, 191, 36, 0.25)",
    background: "rgba(251, 191, 36, 0.06)",
  },
  corsCode: {
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
    background: "rgba(255,255,255,0.08)",
    padding: "1px 5px",
    borderRadius: "3px",
  },
};

export default App;
