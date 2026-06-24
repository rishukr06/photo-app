import React, { useState } from "react";
import { 
  X, 
  ArrowRight, 
  ArrowLeft, 
  UserPlus, 
  FolderPlus, 
  Key, 
  Settings, 
  HelpCircle,
  Copy,
  Check,
  ExternalLink,
  ShieldAlert,
  CheckCircle
} from "lucide-react";

interface UserGuideProps {
  isOpen: boolean;
  onClose: () => void;
}

export const UserGuide: React.FC<UserGuideProps> = ({ isOpen, onClose }) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [copiedCors, setCopiedCors] = useState(false);

  if (!isOpen) return null;

  const totalSteps = 5;

  const corsConfigJson = JSON.stringify([
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag", "x-amz-meta-original-name", "x-amz-meta-file-date", "x-amz-meta-date-taken", "x-amz-meta-gps-lat", "x-amz-meta-gps-lng", "x-amz-meta-gps-altitude", "x-amz-meta-camera-make", "x-amz-meta-camera-model"],
      "MaxAgeSeconds": 3000
    }
  ], null, 2);

  const handleCopyCors = async () => {
    try {
      await navigator.clipboard.writeText(corsConfigJson);
      setCopiedCors(true);
      setTimeout(() => setCopiedCors(false), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const nextStep = () => {
    if (currentStep < totalSteps) setCurrentStep(currentStep + 1);
  };

  const prevStep = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  return (
    <div className="modal-overlay" style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalContent} onClick={(e) => e.stopPropagation()} className="glass-panel animate-slide-up modal-content user-guide-modal">
        {/* Header */}
        <div className="modal-header" style={styles.modalHeader}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <HelpCircle size={24} color="var(--color-primary)" />
            <h3 style={{ fontSize: "1.2rem", fontWeight: "700" }}>AWS S3 Configuration Guide</h3>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Steps Progress Bar */}
        <div className="modal-progress-bar" style={styles.progressBar}>
          {Array.from({ length: totalSteps }, (_, i) => i + 1).map((step) => (
            <div key={step} style={styles.stepIndicatorWrapper}>
              <div 
                style={{
                  ...styles.stepDot,
                  backgroundColor: step <= currentStep ? "var(--color-primary)" : "rgba(255,255,255,0.05)",
                  borderColor: step === currentStep ? "var(--color-secondary)" : "var(--border-color)"
                }}
                onClick={() => setCurrentStep(step)}
              >
                {step}
              </div>
              <span style={{
                ...styles.stepLabel,
                color: step === currentStep ? "var(--text-primary)" : "var(--text-muted)"
              }}>
                {step === 1 && "AWS Account"}
                {step === 2 && "S3 Bucket"}
                {step === 3 && "CORS Rules"}
                {step === 4 && "Access Keys"}
                {step === 5 && "Connect"}
              </span>
            </div>
          ))}
        </div>

        {/* Steps Content Area */}
        <div className="modal-body user-guide-body" style={styles.modalBody}>
          {currentStep === 1 && (
            <div style={styles.stepContent} className="animate-fade-in">
              <div style={styles.iconHeading}>
                <div style={styles.stepIconCircle}><UserPlus size={24} /></div>
                <h4>Step 1: Create an Amazon Web Services (AWS) Account</h4>
              </div>
              <p style={styles.stepText}>
                Amazon S3 is a highly reliable cloud file storage service. To use it, you first need to register on Amazon Web Services.
              </p>
              <ol style={styles.orderedList}>
                <li>Go to the <a href="https://aws.amazon.com/" target="_blank" rel="noopener noreferrer" style={styles.link}>AWS Homepage <ExternalLink size={12} style={{ display: "inline", verticalAlign: "middle" }} /></a>.</li>
                <li>Click the orange <strong>"Create an AWS Account"</strong> button in the top right.</li>
                <li>Enter your email, choose an account name, and verify your email address.</li>
                <li>Provide billing details. AWS offers a <strong>Free Tier</strong> which includes <strong>5 GB</strong> of S3 storage free for your first 12 months!</li>
                <li>Complete the identity verification step (via SMS/phone call) and select the free <strong>Basic Support Plan</strong>.</li>
              </ol>
              <div style={styles.noteBox}>
                <ShieldAlert size={18} color="var(--color-warning)" style={{ flexShrink: 0, marginTop: "2px" }} />
                <span><strong>Billing Info:</strong> S3 is extremely cheap. After the free tier, storing 10 GB of photos costs roughly <strong>$0.23 per month</strong>. Amazon requires a credit card to prevent spam accounts.</span>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div style={styles.stepContent} className="animate-fade-in">
              <div style={styles.iconHeading}>
                <div style={styles.stepIconCircle}><FolderPlus size={24} /></div>
                <h4>Step 2: Create your S3 Storage Bucket</h4>
              </div>
              <p style={styles.stepText}>
                Buckets are the folders inside S3 where files are stored. Let's create one for your photos and videos.
              </p>
              <ol style={styles.orderedList}>
                <li>Log in to your new AWS Console.</li>
                <li>In the top search search bar, type <strong>"S3"</strong> and click the first service listed.</li>
                <li>Click the orange <strong>"Create bucket"</strong> button.</li>
                <li><strong>Bucket Name:</strong> Enter a unique name (e.g., <code>my-family-gallery-2026</code>). Only lowercase letters, numbers, and hyphens are allowed.</li>
                <li><strong>AWS Region:</strong> Choose a region physically close to you (e.g., <em>US East (N. Virginia) us-east-1</em> or <em>Asia Pacific (Mumbai) ap-south-1</em>) for faster speeds.</li>
                <li><strong>Block Public Access:</strong> Keep <strong>"Block all public access"</strong> checked (enabled). This ensures your files are completely private. S3Store signs URLs locally using your keys so only you can view them!</li>
                <li>Scroll to the bottom and click <strong>"Create bucket"</strong>.</li>
              </ol>
            </div>
          )}

          {currentStep === 3 && (
            <div style={styles.stepContent} className="animate-fade-in">
              <div style={styles.iconHeading}>
                <div style={styles.stepIconCircle}><Settings size={24} /></div>
                <h4>Step 3: Allow Browser Uploads (Configure CORS)</h4>
              </div>
              <p style={styles.stepText}>
                Because S3Store runs entirely inside your browser (no server backend), AWS blocks security requests by default. We must add "CORS rules" to allow S3Store to communicate with S3.
              </p>
              <ol style={styles.orderedList}>
                <li>On the S3 dashboard, click on the name of the bucket you just created.</li>
                <li>Select the <strong>"Permissions"</strong> tab under the bucket name.</li>
                <li>Scroll down to the bottom section labeled <strong>"Cross-origin resource sharing (CORS)"</strong> and click <strong>"Edit"</strong>.</li>
                <li>Copy the JSON code configuration block below by clicking the button, and paste it into the editor window.</li>
                <li>Click <strong>"Save changes"</strong>.</li>
              </ol>
              
              <div style={styles.corsPasteBox}>
                <div style={styles.corsHeader}>
                  <span style={{ fontSize: "0.8rem", fontWeight: "700", fontFamily: "var(--font-heading)" }}>CORS JSON Template</span>
                  <button className="btn btn-secondary" onClick={handleCopyCors} style={{ padding: "6px 12px", fontSize: "0.75rem" }}>
                    {copiedCors ? (
                      <>
                        <Check size={12} color="var(--color-success)" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        <span>Copy Code</span>
                      </>
                    )}
                  </button>
                </div>
                <pre style={styles.preCode}>
                  <code style={{ color: "inherit", background: "transparent", padding: 0 }}>{corsConfigJson}</code>
                </pre>
              </div>
            </div>
          )}

          {currentStep === 4 && (
            <div style={styles.stepContent} className="animate-fade-in">
              <div style={styles.iconHeading}>
                <div style={styles.stepIconCircle}><Key size={24} /></div>
                <h4>Step 4: Obtain Access Keys (IAM Credentials)</h4>
              </div>
              <p style={styles.stepText}>
                Access keys act as a secure login name and password that allow our app to write and read from your S3 bucket.
              </p>
              <ol style={styles.orderedList}>
                <li>In the top AWS Console search bar, type <strong>"IAM"</strong> and open the service.</li>
                <li>Click <strong>"Users"</strong> on the left sidebar, and then click <strong>"Create user"</strong>.</li>
                <li>Enter a username (e.g., <code>s3store-app-user</code>). Leave "Provide user access to AWS Management Console" <strong>UNCHECKED</strong>. Click Next.</li>
                <li><strong>Set Permissions:</strong> Select <strong>"Attach policies directly"</strong>.</li>
                <li>In the Policy Search box, type <code>AmazonS3FullAccess</code>. Check the box next to it. Click Next.</li>
                <li>Review details and click <strong>"Create user"</strong>.</li>
                <li>On the Users list, click on the name of the user you just created.</li>
                <li>Go to the <strong>"Security credentials"</strong> tab. Scroll down to <strong>"Access keys"</strong> and click <strong>"Create access key"</strong>.</li>
                <li>Select <strong>"Local code"</strong> or <strong>"Other"</strong> as the use case. Click Next.</li>
                <li>Click <strong>"Create access key"</strong>. Copy BOTH the <strong>Access Key ID</strong> and the <strong>Secret Access Key</strong>!</li>
              </ol>
              <div style={{ ...styles.noteBox, borderColor: "rgba(239, 68, 68, 0.2)", backgroundColor: "var(--color-danger-bg)" }}>
                <ShieldAlert size={18} color="var(--color-danger)" style={{ flexShrink: 0, marginTop: "2px" }} />
                <span style={{ color: "var(--color-danger)" }}><strong>Warning:</strong> Keep these keys private! Anyone with these keys can access your S3 bucket. Never share them or upload them to public websites.</span>
              </div>
            </div>
          )}

          {currentStep === 5 && (
            <div style={{ ...styles.stepContent, textAlign: "center" }} className="animate-fade-in">
              <div style={{ ...styles.stepIconCircle, width: "64px", height: "64px", margin: "0 auto 20px auto" }}>
                <CheckCircle size={32} color="var(--color-success)" />
              </div>
              <h4>All Set! Let's Connect</h4>
              <p style={{ ...styles.stepText, maxWidth: "500px", margin: "0 auto 24px auto" }}>
                You have configured S3 and generated keys. Now, put them into the S3Store application to start syncing files!
              </p>
              
              <div style={styles.fieldsOverviewCard} className="glass-panel">
                <h5 style={{ fontWeight: 700, marginBottom: "12px", fontSize: "0.9rem" }}>What to enter in the Setup Wizard:</h5>
                <div style={styles.fieldRow}>
                  <span style={styles.fieldLabel}>Access Key ID:</span>
                  <span style={styles.fieldDesc}>The login string starting with <code>AKIA...</code></span>
                </div>
                <div style={styles.fieldRow}>
                  <span style={styles.fieldLabel}>Secret Access Key:</span>
                  <span style={styles.fieldDesc}>The long hidden secret key.</span>
                </div>
                <div style={styles.fieldRow}>
                  <span style={styles.fieldLabel}>S3 Bucket Name:</span>
                  <span style={styles.fieldDesc}>The exact bucket name you created.</span>
                </div>
                <div style={styles.fieldRow}>
                  <span style={styles.fieldLabel}>AWS Region:</span>
                  <span style={styles.fieldDesc}>The region code of your bucket (e.g. <code>us-east-1</code>).</span>
                </div>
              </div>

              <button className="btn btn-primary" onClick={onClose} style={{ marginTop: "24px", minWidth: "160px" }}>
                Back to Setup Wizard
              </button>
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div className="modal-footer" style={styles.modalFooter}>
          <button 
            className="btn btn-secondary" 
            onClick={prevStep}
            disabled={currentStep === 1}
            style={{ opacity: currentStep === 1 ? 0.3 : 1 }}
          >
            <ArrowLeft size={16} />
            <span>Back</span>
          </button>
          
          <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)", fontWeight: "600" }}>
            Step {currentStep} of {totalSteps}
          </span>

          {currentStep < totalSteps ? (
            <button className="btn btn-primary" onClick={nextStep}>
              <span>Next Step</span>
              <ArrowRight size={16} />
            </button>
          ) : (
            <button className="btn btn-secondary" onClick={onClose}>
              <span>Close Guide</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    width: "100vw",
    height: "100vh",
    background: "rgba(3, 5, 10, 0.8)",
    backdropFilter: "blur(12px)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 2000,
    padding: "20px",
  },
  modalContent: {
    width: "100%",
    maxWidth: "800px",
    height: "85vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: "var(--bg-surface)",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 24px",
    borderBottom: "1px solid var(--border-color)",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "6px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  progressBar: {
    display: "flex",
    justifyContent: "space-between",
    padding: "20px 40px",
    borderBottom: "1px solid var(--border-color)",
    backgroundColor: "rgba(0,0,0,0.1)",
    overflowX: "auto",
    gap: "16px",
  },
  stepIndicatorWrapper: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    minWidth: "70px",
  },
  stepDot: {
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontSize: "0.8rem",
    fontWeight: "800",
    color: "#fff",
    border: "2px solid",
    cursor: "pointer",
    transition: "all var(--transition-fast)",
  },
  stepLabel: {
    fontSize: "0.75rem",
    fontWeight: "700",
    whiteSpace: "nowrap",
  },
  modalBody: {
    flex: 1,
    overflowY: "auto",
    padding: "32px 40px",
  },
  stepContent: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    textAlign: "left",
  },
  iconHeading: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "8px",
  },
  stepIconCircle: {
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    background: "rgba(99, 102, 241, 0.1)",
    border: "1px solid var(--border-color-active)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    color: "var(--color-primary)",
  },
  stepText: {
    fontSize: "0.95rem",
    color: "var(--text-secondary)",
    lineHeight: "1.5",
  },
  orderedList: {
    paddingLeft: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    fontSize: "0.9rem",
    color: "var(--text-primary)",
    lineHeight: "1.5",
  },
  link: {
    color: "var(--color-primary)",
    textDecoration: "underline",
    fontWeight: "600",
  },
  noteBox: {
    display: "flex",
    gap: "12px",
    padding: "14px 16px",
    borderRadius: "var(--radius-md)",
    border: "1px solid rgba(245, 158, 11, 0.2)",
    backgroundColor: "var(--color-warning-bg)",
    color: "var(--color-warning)",
    fontSize: "0.85rem",
    lineHeight: "1.4",
    marginTop: "16px",
  },
  corsPasteBox: {
    marginTop: "20px",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    border: "1px solid var(--border-color)",
  },
  corsHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 16px",
    backgroundColor: "rgba(0,0,0,0.3)",
    borderBottom: "1px solid var(--border-color)",
  },
  preCode: {
    background: "#05070e",
    color: "#e2e8f0",
    padding: "16px",
    margin: 0,
    fontSize: "0.8rem",
    overflowX: "auto",
    textAlign: "left",
  },
  fieldsOverviewCard: {
    padding: "20px",
    backgroundColor: "rgba(0,0,0,0.1)",
    borderRadius: "var(--radius-md)",
    maxWidth: "500px",
    margin: "0 auto",
    textAlign: "left",
  },
  fieldRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 0",
    borderBottom: "1px solid var(--border-color)",
    fontSize: "0.85rem",
  },
  fieldLabel: {
    fontWeight: "700",
    color: "var(--text-primary)",
    width: "140px",
  },
  fieldDesc: {
    color: "var(--text-secondary)",
    flex: 1,
  },
  modalFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 24px",
    borderTop: "1px solid var(--border-color)",
    backgroundColor: "rgba(0,0,0,0.05)",
  },
};
