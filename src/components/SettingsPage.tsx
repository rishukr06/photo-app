import { useState } from "react";
import { ArrowLeft, Sun, Moon, LogOut, Shield, Info, HelpCircle, Database, RefreshCw } from "lucide-react";
import type { S3Credentials } from "../utils/s3";

interface SettingsPageProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  creds: S3Credentials | null;
  onDisconnect: () => void;
  onBack: () => void;
  onOpenGuide: () => void;
}

async function clearAppCacheAndReload() {
  // Clear all Cache API caches (service worker caches, if any)
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  }
  // Clear only our app's cached data — keep credentials and theme preference
  Object.keys(localStorage)
    .filter(k =>
      k.startsWith("s3store_list_") ||
      k.startsWith("s3store_url_")  ||
      k.startsWith("s3store_metaidx_")
    )
    .forEach(k => localStorage.removeItem(k));
  // Bust the URL so iOS PWA fetches a fresh index.html rather than the cached one
  const bust = "?v=" + Date.now();
  window.location.replace(window.location.origin + window.location.pathname + bust);
}

export function SettingsPage({ theme, onToggleTheme, creds, onDisconnect, onBack, onOpenGuide }: SettingsPageProps) {
  const [clearing, setClearing] = useState(false);
  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <button style={s.backBtn} onClick={onBack}>
          <ArrowLeft size={18} />
          <span>Back</span>
        </button>
        <h2 style={s.title}>Settings</h2>
      </div>

      <div style={s.sections}>
        {/* Appearance */}
        <section style={s.section}>
          <p style={s.sectionLabel}>Appearance</p>
          <div style={s.card}>
            <div style={s.row} onClick={onToggleTheme}>
              <div style={s.rowLeft}>
                <div style={s.iconWrap}>
                  {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
                </div>
                <div>
                  <p style={s.rowTitle}>Theme</p>
                  <p style={s.rowSub}>{theme === "dark" ? "Dark mode" : "Light mode"}</p>
                </div>
              </div>
              {/* Toggle pill */}
              <div
                style={{
                  ...s.toggle,
                  background: "var(--color-primary)",
                  justifyContent: theme === "dark" ? "flex-end" : "flex-start",
                }}
              >
                <div style={s.toggleKnob} />
              </div>
            </div>
          </div>
        </section>

        {/* Connection */}
        {creds && (
          <section style={s.section}>
            <p style={s.sectionLabel}>Connection</p>
            <div style={s.card}>
              <div style={s.infoRow}>
                <div style={s.iconWrap}><Database size={16} /></div>
                <div style={{ minWidth: 0 }}>
                  <p style={s.rowTitle}>Bucket</p>
                  <p style={{ ...s.rowSub, wordBreak: "break-all" }}>{creds.bucketName}</p>
                </div>
              </div>
              <div style={s.divider} />
              <div style={s.infoRow}>
                <div style={s.iconWrap}><Shield size={16} /></div>
                <div>
                  <p style={s.rowTitle}>Region</p>
                  <p style={s.rowSub}>{creds.region}</p>
                </div>
              </div>
              {creds.endpoint && (
                <>
                  <div style={s.divider} />
                  <div style={s.infoRow}>
                    <div style={s.iconWrap}><Info size={16} /></div>
                    <div style={{ minWidth: 0 }}>
                      <p style={s.rowTitle}>Endpoint</p>
                      <p style={{ ...s.rowSub, wordBreak: "break-all" }}>{creds.endpoint}</p>
                    </div>
                  </div>
                </>
              )}
              {creds.prefix && (
                <>
                  <div style={s.divider} />
                  <div style={s.infoRow}>
                    <div style={s.iconWrap}><Info size={16} /></div>
                    <div>
                      <p style={s.rowTitle}>Prefix</p>
                      <p style={s.rowSub}>{creds.prefix}</p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {/* Help */}
        <section style={s.section}>
          <p style={s.sectionLabel}>Help</p>
          <div style={s.card}>
            <div style={s.row} onClick={onOpenGuide}>
              <div style={s.rowLeft}>
                <div style={s.iconWrap}><HelpCircle size={16} /></div>
                <div>
                  <p style={s.rowTitle}>AWS Setup Guide</p>
                  <p style={s.rowSub}>CORS, IAM policy, bucket config</p>
                </div>
              </div>
              <span style={s.chevron}>›</span>
            </div>
          </div>
        </section>

        {/* App cache */}
        <section style={s.section}>
          <p style={s.sectionLabel}>App</p>
          <div style={s.card}>
            <div
              style={{ ...s.row, cursor: clearing ? "default" : "pointer", opacity: clearing ? 0.6 : 1 }}
              onClick={async () => {
                if (clearing) return;
                setClearing(true);
                await clearAppCacheAndReload();
              }}
            >
              <div style={s.rowLeft}>
                <div style={s.iconWrap}>
                  <RefreshCw size={16} style={clearing ? { animation: "spin 0.8s linear infinite" } : undefined} />
                </div>
                <div>
                  <p style={s.rowTitle}>{clearing ? "Clearing…" : "Clear Cache & Reload"}</p>
                  <p style={s.rowSub}>Force downloads the latest app version. Fixes camera or loading issues after updates.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Danger zone */}
        {creds && (
          <section style={s.section}>
            <p style={s.sectionLabel}>Account</p>
            <div style={s.card}>
              <div
                style={{ ...s.row, cursor: "pointer" }}
                onClick={() => {
                  if (window.confirm("Disconnect and remove credentials from this browser?")) {
                    onDisconnect();
                  }
                }}
              >
                <div style={s.rowLeft}>
                  <div style={{ ...s.iconWrap, color: "var(--color-danger)" }}>
                    <LogOut size={16} />
                  </div>
                  <div>
                    <p style={{ ...s.rowTitle, color: "var(--color-danger)" }}>Disconnect bucket</p>
                    <p style={s.rowSub}>Removes credentials from this device</p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        <p style={s.version}>S3Store · All operations run in your browser</p>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    width: "100%",
    maxWidth: "560px",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "0",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "28px",
    paddingBottom: "20px",
    borderBottom: "1px solid var(--border-color)",
  },
  backBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    background: "none",
    border: "none",
    color: "var(--color-primary)",
    cursor: "pointer",
    fontSize: "0.9rem",
    fontWeight: "600",
    fontFamily: "var(--font-sans)",
    padding: "6px 10px 6px 4px",
    borderRadius: "var(--radius-sm)",
    transition: "opacity 0.15s",
    flexShrink: 0,
  },
  title: {
    fontSize: "1.15rem",
    fontWeight: "700",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    margin: 0,
  },
  sections: {
    display: "flex",
    flexDirection: "column",
    gap: "28px",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  sectionLabel: {
    fontSize: "0.7rem",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-muted)",
    margin: "0 0 0 4px",
  },
  card: {
    background: "var(--surface-primary)",
    border: "1px solid var(--border-color)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px",
    cursor: "pointer",
    transition: "background 0.12s",
    gap: "12px",
  },
  infoRow: {
    display: "flex",
    alignItems: "flex-start",
    padding: "14px 16px",
    gap: "12px",
  },
  rowLeft: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flex: 1,
    minWidth: 0,
  },
  iconWrap: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid var(--border-color)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: "var(--text-secondary)",
  },
  rowTitle: {
    fontSize: "0.875rem",
    fontWeight: "500",
    color: "var(--text-primary)",
    margin: 0,
    lineHeight: 1.4,
  },
  rowSub: {
    fontSize: "0.75rem",
    color: "var(--text-muted)",
    margin: "2px 0 0",
    lineHeight: 1.4,
  },
  chevron: {
    fontSize: "1.2rem",
    color: "var(--text-muted)",
    flexShrink: 0,
  },
  divider: {
    height: "1px",
    background: "var(--border-color)",
    margin: "0 16px",
  },
  toggle: {
    width: "42px",
    height: "24px",
    borderRadius: "12px",
    display: "flex",
    alignItems: "center",
    padding: "3px",
    flexShrink: 0,
    cursor: "pointer",
    transition: "background 0.2s",
    boxSizing: "border-box",
  },
  toggleKnob: {
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "#fff",
    flexShrink: 0,
    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
  },
  version: {
    textAlign: "center",
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    opacity: 0.5,
    marginTop: "8px",
  },
};
