import React, { useState, useEffect } from "react";
import { 
  Key, 
  Database, 
  Globe, 
  HardDrive, 
  Play, 
  CheckCircle, 
  AlertCircle, 
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Lock
} from "lucide-react";
import { testS3Connection } from "../utils/s3";
import type { S3Credentials } from "../utils/s3";

interface SetupWizardProps {
  onConnectionSuccess: (creds: S3Credentials) => void;
  onOpenGuide: () => void;
}

const COMMON_REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-1", label: "US West (N. California)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  { value: "eu-west-1", label: "Europe (Ireland)" },
  { value: "eu-central-1", label: "Europe (Frankfurt)" },
  { value: "sa-east-1", label: "South America (São Paulo)" },
];

export const SetupWizard: React.FC<SetupWizardProps> = ({ onConnectionSuccess, onOpenGuide }) => {
  const [creds, setCreds] = useState<S3Credentials>({
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    region: "us-east-1",
    bucketName: "",
    endpoint: "",
    prefix: "",
  });

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showCorsHelp, setShowCorsHelp] = useState(false);
  const [customRegion, setCustomRegion] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("s3store_creds");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setCreds(parsed);
        
        // If the region is not in our common list, enable custom region mode
        if (parsed.region && !COMMON_REGIONS.some(r => r.value === parsed.region)) {
          setCustomRegion(true);
        }
      } catch (e) {
        console.error("Error parsing saved credentials:", e);
      }
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setCreds(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleTestConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setTestResult(null);

    // Clean inputs
    const cleanCreds: S3Credentials = {
      accessKeyId: creds.accessKeyId.trim(),
      secretAccessKey: creds.secretAccessKey.trim(),
      sessionToken: creds.sessionToken?.trim() || undefined,
      region: creds.region.trim(),
      bucketName: creds.bucketName.trim(),
      endpoint: creds.endpoint?.trim() || undefined,
      prefix: creds.prefix?.trim() || undefined,
    };

    try {
      await testS3Connection(cleanCreds);
      setTestResult({
        success: true,
        message: "Successfully connected to S3! Credentials are valid."
      });
      // Save credentials in localStorage
      localStorage.setItem("s3store_creds", JSON.stringify(cleanCreds));
      
      // Auto transition after 1.5 seconds
      setTimeout(() => {
        onConnectionSuccess(cleanCreds);
      }, 1500);

    } catch (err: any) {
      console.error("S3 Connection Error:", err);
      let errorMsg = err.message || "Failed to connect to S3. Unknown error.";
      
      // Check if it's likely a CORS error (TypeError: Failed to fetch or NetworkError)
      if (err.toString().includes("TypeError: Failed to fetch") || err.name === "TypeError" || err.message === "Failed to fetch") {
        errorMsg = "Connection failed! This is highly likely a CORS issue. S3 blocked the browser request because CORS (Cross-Origin Resource Sharing) is not configured or rejects this origin. Click the CORS Helper below to fix this.";
        setShowCorsHelp(true);
      } else if (err.name === "InvalidAccessKeyId" || err.toString().includes("InvalidAccessKeyId")) {
        errorMsg = "Invalid AWS Access Key ID. Please check the spelling.";
      } else if (err.name === "SignatureDoesNotMatch" || err.toString().includes("SignatureDoesNotMatch")) {
        errorMsg = "Signature does not match. Please verify your Secret Access Key.";
      } else if (err.name === "NoSuchBucket" || err.toString().includes("NoSuchBucket")) {
        errorMsg = `Bucket "${cleanCreds.bucketName}" does not exist in region "${cleanCreds.region}".`;
      }
      
      setTestResult({
        success: false,
        message: errorMsg
      });
    } finally {
      setTesting(false);
    }
  };

  const corsConfigJson = JSON.stringify([
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }
  ], null, 2);

  return (
    <div style={styles.container} className="animate-slide-up">
      <div style={styles.card} className="glass-panel">
        <div style={styles.header}>
          <div style={styles.iconCircle}>
            <Lock size={28} color="var(--color-primary)" />
          </div>
          <h2 style={styles.title}>Configure AWS S3 Store</h2>
          <p style={styles.subtitle}>
            Enter S3 credentials to connect. They are stored locally in your browser's <code style={{fontSize: "12px"}}>localStorage</code> and never sent to any server.
          </p>
          <button 
            type="button" 
            className="btn btn-secondary"
            onClick={onOpenGuide}
            style={{ marginTop: "16px", display: "inline-flex", alignItems: "center", gap: "8px", height: "40px" }}
          >
            <HelpCircle size={16} color="var(--color-primary)" />
            <span>Need help? View AWS Setup Guide</span>
          </button>
        </div>

        <form onSubmit={handleTestConnection} style={styles.form}>
          <div style={styles.row} className="form-row-responsive">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label" htmlFor="accessKeyId">
                <Key size={14} style={styles.labelIcon} /> Access Key ID
              </label>
              <input
                id="accessKeyId"
                type="text"
                name="accessKeyId"
                className="form-input"
                placeholder="AKIAIOSFODNN7EXAMPLE"
                value={creds.accessKeyId}
                onChange={handleChange}
                required
              />
            </div>
            
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label" htmlFor="secretAccessKey">
                <Key size={14} style={styles.labelIcon} /> Secret Access Key
              </label>
              <input
                id="secretAccessKey"
                type="password"
                name="secretAccessKey"
                className="form-input"
                placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                value={creds.secretAccessKey}
                onChange={handleChange}
                required
              />
            </div>
          </div>

          <div style={styles.row} className="form-row-responsive">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label" htmlFor="region">
                <Globe size={14} style={styles.labelIcon} /> AWS Region
              </label>
              {customRegion ? (
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    id="region"
                    type="text"
                    name="region"
                    className="form-input"
                    placeholder="us-east-1"
                    value={creds.region}
                    onChange={handleChange}
                    required
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setCustomRegion(false);
                      setCreds(p => ({ ...p, region: "us-east-1" }));
                    }}
                    style={{ padding: "10px" }}
                  >
                    Select
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: "8px" }}>
                  <select
                    id="region"
                    name="region"
                    className="form-input"
                    value={creds.region}
                    onChange={handleChange}
                    style={{ flex: 1, height: "45px", appearance: "none", backgroundPosition: "right 16px center" }}
                  >
                    {COMMON_REGIONS.map(r => (
                      <option key={r.value} value={r.value} style={{ background: "#0c1226" }}>
                        {r.label} ({r.value})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setCustomRegion(true)}
                    style={{ padding: "10px" }}
                  >
                    Custom
                  </button>
                </div>
              )}
            </div>

            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label" htmlFor="bucketName">
                <Database size={14} style={styles.labelIcon} /> S3 Bucket Name
              </label>
              <input
                id="bucketName"
                type="text"
                name="bucketName"
                className="form-input"
                placeholder="my-photo-gallery"
                value={creds.bucketName}
                onChange={handleChange}
                required
              />
            </div>
          </div>

          <div style={styles.divider}>
            <span style={styles.dividerText}>Advanced Settings</span>
          </div>

          <div style={styles.row} className="form-row-responsive">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label" htmlFor="endpoint">
                <HardDrive size={14} style={styles.labelIcon} /> Custom Endpoint (Optional)
              </label>
              <input
                id="endpoint"
                type="url"
                name="endpoint"
                className="form-input"
                placeholder="https://<account-id>.r2.cloudflarestorage.com"
                value={creds.endpoint || ""}
                onChange={handleChange}
              />
              <span style={styles.helpText}>For Cloudflare R2, MinIO, or custom S3 backends.</span>
            </div>

            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label" htmlFor="prefix">
                <HardDrive size={14} style={styles.labelIcon} /> Key Prefix/Folder (Optional)
              </label>
              <input
                id="prefix"
                type="text"
                name="prefix"
                className="form-input"
                placeholder="s3store/"
                value={creds.prefix || ""}
                onChange={handleChange}
              />
              <span style={styles.helpText}>Uploads and scans will be confined here (must end in /).</span>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="sessionToken">
              Session Token (Optional)
            </label>
            <input
              id="sessionToken"
              type="text"
              name="sessionToken"
              className="form-input"
              placeholder="FwoGZXIvYXdzEOb//////////wEaM..."
              value={creds.sessionToken || ""}
              onChange={handleChange}
            />
            <span style={styles.helpText}>Only required if using temporary IAM/STS credentials.</span>
          </div>

          {testResult && (
            <div 
              style={{
                ...styles.alert,
                backgroundColor: testResult.success ? "var(--color-success-bg)" : "var(--color-danger-bg)",
                borderColor: testResult.success ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)",
                color: testResult.success ? "var(--color-success)" : "var(--color-danger)"
              }}
            >
              {testResult.success ? (
                <CheckCircle size={20} style={{ flexShrink: 0, color: "var(--color-success)" }} />
              ) : (
                <AlertCircle size={20} style={{ flexShrink: 0, color: "var(--color-danger)" }} />
              )}
              <div style={styles.alertContent}>{testResult.message}</div>
            </div>
          )}

          <div style={styles.buttonRow}>
            <button 
              type="submit" 
              className="btn btn-primary" 
              style={{ width: "100%", height: "48px" }}
              disabled={testing}
            >
              {testing ? (
                <>
                  <div className="pulse" style={{ display: "inline-block", marginRight: "8px" }}>● ● ●</div>
                  Verifying Connection...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Connect & Verify S3
                </>
              )}
            </button>
          </div>
        </form>

        <div style={styles.corsContainer}>
          <button 
            type="button" 
            style={styles.corsToggleButton}
            onClick={() => setShowCorsHelp(!showCorsHelp)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <HelpCircle size={16} />
              <span>How to configure S3 CORS (Required for web uploads)</span>
            </div>
            {showCorsHelp ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          {showCorsHelp && (
            <div style={styles.corsContent} className="animate-fade-in">
              <p style={{ marginBottom: "12px", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                Because this application runs 100% in your browser, S3 will reject file uploads/downloads unless you configure CORS in your AWS Bucket settings.
              </p>
              <h4 style={{ fontSize: "0.85rem", marginBottom: "6px" }}>Amazon S3 Console Setup:</h4>
              <ol style={{ paddingLeft: "20px", fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "12px" }}>
                <li>Go to AWS Console &rarr; S3 &rarr; Select your bucket &rarr; <strong>Permissions</strong> tab.</li>
                <li>Scroll down to <strong>Cross-origin resource sharing (CORS)</strong> and click <strong>Edit</strong>.</li>
                <li>Paste the JSON config below and click <strong>Save changes</strong>.</li>
              </ol>
              <pre style={styles.pre}>
                <code style={{ color: "inherit", background: "transparent", padding: 0 }}>{corsConfigJson}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "32px 20px",
    width: "100%",
  },
  card: {
    width: "100%",
    maxWidth: "740px",
    padding: "36px",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    marginBottom: "28px",
  },
  iconCircle: {
    width: "52px",
    height: "52px",
    borderRadius: "50%",
    background: "var(--color-primary-dim)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: "16px",
    border: "1px solid var(--border-color-hover)",
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: "600",
    marginBottom: "8px",
    letterSpacing: "-0.01em",
    color: "var(--text-primary)",
  },
  subtitle: {
    fontSize: "0.875rem",
    color: "var(--text-secondary)",
    lineHeight: "1.6",
    maxWidth: "480px",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "18px",
  },
  row: {
    display: "flex",
    gap: "18px",
    flexWrap: "wrap",
  },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    margin: "8px 0 2px 0",
  },
  dividerText: {
    fontSize: "0.72rem",
    fontWeight: "600",
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    whiteSpace: "nowrap",
  },
  labelIcon: {
    verticalAlign: "middle",
    opacity: 0.75,
  },
  helpText: {
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    marginTop: "3px",
    lineHeight: "1.4",
  },
  alert: {
    display: "flex",
    gap: "12px",
    padding: "13px 15px",
    borderRadius: "var(--radius-md)",
    border: "1px solid",
    fontSize: "0.84rem",
    lineHeight: "1.45",
  },
  alertContent: {
    flex: 1,
  },
  buttonRow: {
    marginTop: "6px",
  },
  corsContainer: {
    marginTop: "24px",
    borderTop: "1px solid var(--border-color)",
    paddingTop: "18px",
  },
  corsToggleButton: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    cursor: "pointer",
    fontSize: "0.83rem",
    fontWeight: "500",
    padding: "6px 0",
    fontFamily: "var(--font-sans)",
    transition: "color var(--transition-fast)",
  },
  corsContent: {
    marginTop: "10px",
    textAlign: "left",
    background: "rgba(0, 0, 0, 0.15)",
    padding: "16px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-color)",
  },
  pre: {
    background: "rgba(0, 0, 0, 0.4)",
    color: "var(--text-secondary)",
    padding: "12px 14px",
    borderRadius: "var(--radius-md)",
    overflowX: "auto",
    fontSize: "0.75rem",
    fontFamily: "var(--font-mono)",
    border: "1px solid var(--border-color)",
    lineHeight: "1.6",
  },
};
