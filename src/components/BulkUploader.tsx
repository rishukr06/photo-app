import React, { useState, useRef, useEffect, useMemo } from "react";
import { 
  UploadCloud, 
  File, 
  Image as ImageIcon, 
  Video as VideoIcon, 
  Trash2, 
  Calendar, 
  Check, 
  AlertCircle, 
  RefreshCw,
  Sliders,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import { uploadS3FileWithProgress } from "../utils/s3";
import type { S3Credentials, S3MediaItem } from "../utils/s3";
import { extractMetadata } from "../utils/metadata";
import { batchUpsertMetaEntries } from "../utils/metaIndex";
import type { MetaEntry } from "../utils/metaIndex";
import { reverseGeocode } from "../utils/geocode";

interface BulkUploaderProps {
  creds: S3Credentials;
  existingItems: S3MediaItem[];
  onUploadComplete: () => void;
}

interface UploadQueueItem {
  id: string;
  file: File;
  name: string;
  size: number;
  lastModifiedDate: Date;
  status: "ready" | "skipped-duplicate" | "filtered-date" | "uploading" | "success" | "failed";
  progress: number;
  error?: string;
  selected: boolean;
  previewUrl?: string;
}

export const BulkUploader: React.FC<BulkUploaderProps> = ({ creds, existingItems, onUploadComplete }) => {
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [filterByDate, setFilterByDate] = useState<boolean>(false);
  const [skipDuplicates, setSkipDuplicates] = useState<boolean>(true);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [activeUploadsCount, setActiveUploadsCount] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [filtersExpanded, setFiltersExpanded] = useState<boolean>(true);

  // Auto-collapse filters on mobile on mount
  useEffect(() => {
    if (window.innerWidth <= 768) {
      setFiltersExpanded(false);
    }
  }, []);

  // Auto clean preview object URLs when queue changes or component unmounts
  useEffect(() => {
    return () => {
      queue.forEach(item => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      });
    };
  }, []);

  // Format file size
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
    }
  };

  const addFilesToQueue = (fileList: FileList) => {
    const newItems: UploadQueueItem[] = [];
    
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const isImage = file.type.startsWith("image/");
      
      newItems.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        name: file.name,
        size: file.size,
        lastModifiedDate: new Date(file.lastModified),
        status: "ready",
        progress: 0,
        selected: true,
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
      });
    }

    setQueue(prev => [...prev, ...newItems]);
  };

  const handleRemoveItem = (id: string) => {
    setQueue(prev => {
      const target = prev.find(item => item.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter(item => item.id !== id);
    });
  };

  const handleClearQueue = () => {
    queue.forEach(item => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    setQueue([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Toggle selection for a single file
  const handleToggleSelect = (id: string) => {
    setQueue(prev => prev.map(item => {
      if (item.id === id) {
        // Can only toggle selection if it is not already uploaded or uploading
        if (item.status === "ready" || item.status === "skipped-duplicate" || item.status === "filtered-date") {
          return { ...item, selected: !item.selected };
        }
      }
      return item;
    }));
  };

  // Toggle selection for ALL files in current view
  const handleSelectAll = (select: boolean) => {
    setQueue(prev => prev.map(item => {
      if (item.status === "ready" || item.status === "skipped-duplicate" || item.status === "filtered-date") {
        return { ...item, selected: select };
      }
      return item;
    }));
  };

  // Map of existing items in S3 for fast O(1) checks
  const existingItemsMap = useMemo(() => {
    const map = new Map<string, number>();
    existingItems.forEach(item => {
      // Map name/key to its size
      map.set(item.key.toLowerCase(), item.size);
    });
    return map;
  }, [existingItems]);

  // Process queue filtering by date and duplicates
  // This hook runs whenever queue, existingItemsMap, date filters, or skipDuplicates changes.
  useEffect(() => {
    setQueue(prev => prev.map(item => {
      // If the item is already uploading, uploaded, or failed, don't change its state
      if (item.status === "uploading" || item.status === "success" || item.status === "failed") {
        return item;
      }

      // Check 1: Date Filter
      if (filterByDate) {
        const itemTime = item.lastModifiedDate.getTime();
        if (fromDate) {
          const fromTime = new Date(fromDate).getTime();
          if (itemTime < fromTime) {
            return { ...item, status: "filtered-date", selected: false };
          }
        }
        if (toDate) {
          // Add 23:59:59 to "to" date to cover the whole day
          const toTime = new Date(toDate).getTime() + (24 * 60 * 60 * 1000 - 1);
          if (itemTime > toTime) {
            return { ...item, status: "filtered-date", selected: false };
          }
        }
      }

      // Check 2: Duplicate Check
      const targetKey = `${creds.prefix || ""}${item.name}`;
      const existingSize = existingItemsMap.get(targetKey.toLowerCase());
      
      if (skipDuplicates && existingSize !== undefined && existingSize === item.size) {
        return { ...item, status: "skipped-duplicate", selected: false };
      }

      // Otherwise, mark as ready
      return { 
        ...item, 
        status: "ready", 
        // Reset selected if it was filtered out before but is now back in scope
        selected: item.status === "filtered-date" || item.status === "skipped-duplicate" ? true : item.selected 
      };
    }));
  }, [filterByDate, fromDate, toDate, skipDuplicates, existingItemsMap, creds.prefix]);

  // Statistics
  const stats = useMemo(() => {
    let total = queue.length;
    let selected = 0;
    let size = 0;
    let duplicates = 0;
    let filtered = 0;
    let ready = 0;

    queue.forEach(item => {
      if (item.status === "skipped-duplicate") duplicates++;
      else if (item.status === "filtered-date") filtered++;
      else if (item.status === "ready") ready++;

      if (item.selected) {
        selected++;
        size += item.size;
      }
    });

    return { total, selected, size, duplicates, filtered, ready };
  }, [queue]);

  // Multi-upload orchestrator with concurrency limit
  const startBulkUpload = async () => {
    if (isUploading) return;
    setIsUploading(true);

    const uploadQueue = queue.filter(item => item.selected && (
      item.status === "ready" ||
      item.status === "skipped-duplicate" ||
      item.status === "filtered-date"
    ));

    if (uploadQueue.length === 0) {
      setIsUploading(false);
      return;
    }

    setQueue(prev => prev.map(item => {
      if (uploadQueue.some(q => q.id === item.id)) {
        return { ...item, status: "uploading", progress: 0 };
      }
      return item;
    }));

    const CONCURRENCY = 3;
    let index = 0;

    // Accumulate EXIF per-key; written once after all uploads finish to avoid race conditions
    const collectedMeta: Record<string, MetaEntry> = {};

    const uploadNext = async (): Promise<void> => {
      if (index >= uploadQueue.length) return;

      const item = uploadQueue[index++];
      setActiveUploadsCount(c => c + 1);

      const destKey = `${creds.prefix || ""}${item.name}`;

      try {
        const metadata = await extractMetadata(item.file);
        await uploadS3FileWithProgress(
          creds,
          item.file,
          destKey,
          (percent) => {
            setQueue(prev => prev.map(q => q.id === item.id ? { ...q, progress: percent } : q));
          },
          metadata as unknown as Record<string, string>
        );

        setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: "success", progress: 100 } : q));

        // Collect EXIF + reverse-geocoded location for the meta index
        const entry: MetaEntry = {};
        if (metadata["date-taken"]) entry.dateTaken = metadata["date-taken"];
        if (metadata["gps-lat"])    entry.gpsLat    = metadata["gps-lat"];
        if (metadata["gps-lng"])    entry.gpsLng    = metadata["gps-lng"];
        if (metadata["gps-lat"] && metadata["gps-lng"]) {
          const geo = await reverseGeocode(metadata["gps-lat"], metadata["gps-lng"]);
          if (geo.city)        entry.city        = geo.city;
          if (geo.country)     entry.country     = geo.country;
          if (geo.countryCode) entry.countryCode = geo.countryCode;
          if (geo.area)        entry.area        = geo.area;
          if (geo.street)      entry.street      = geo.street;
        }
        if (Object.keys(entry).length > 0) collectedMeta[destKey] = entry;
      } catch (err: any) {
        console.error(`Error uploading ${item.name}:`, err);
        setQueue(prev => prev.map(q => q.id === item.id ? {
          ...q,
          status: "failed",
          error: err.message || "Upload failed.",
        } : q));
      } finally {
        setActiveUploadsCount(c => c - 1);
        await uploadNext();
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(CONCURRENCY, uploadQueue.length); i++) {
      workers.push(uploadNext());
    }

    await Promise.all(workers);

    // Write all collected EXIF to the meta index in one batch
    if (Object.keys(collectedMeta).length > 0) {
      try {
        await batchUpsertMetaEntries(creds, collectedMeta);
      } catch (e) {
        console.warn("Meta index update failed (uploads succeeded):", e);
      }
    }

    setIsUploading(false);
    onUploadComplete();
  };

  return (
    <div style={styles.container}>
      <div style={styles.sidebar} className="glass-panel uploader-sidebar-collapse">
        <h3 
          style={{ ...styles.sectionTitle, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
          onClick={() => setFiltersExpanded(!filtersExpanded)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Sliders size={18} color="var(--color-primary)" />
            <span>Upload Settings & Filters</span>
          </div>
          <span style={{ display: "flex", alignItems: "center" }}>
            {filtersExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </h3>

        {filtersExpanded && (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }} className="animate-fade-in">
            {/* Date Filter Toggle */}
            <div style={styles.filterSection}>
              <label style={styles.checkboxLabel}>
                <input 
                  type="checkbox" 
                  checked={filterByDate} 
                  onChange={(e) => setFilterByDate(e.target.checked)}
                  style={styles.checkbox}
                />
                <span style={{ fontWeight: 600 }}>Filter by Date Range</span>
              </label>
              
              <div style={{ ...styles.dateInputs, opacity: filterByDate ? 1 : 0.5, pointerEvents: filterByDate ? "auto" : "none" }}>
                <div className="form-group" style={{ marginBottom: "12px" }}>
                  <label className="form-label">From Date</label>
                  <div style={styles.inputWrapper}>
                    <Calendar size={14} style={styles.inputIcon} />
                    <input 
                      type="date" 
                      className="form-input" 
                      value={fromDate}
                      onChange={(e) => setFromDate(e.target.value)}
                      style={{ paddingLeft: "36px" }}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">To Date</label>
                  <div style={styles.inputWrapper}>
                    <Calendar size={14} style={styles.inputIcon} />
                    <input 
                      type="date" 
                      className="form-input" 
                      value={toDate}
                      onChange={(e) => setToDate(e.target.value)}
                      style={{ paddingLeft: "36px" }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Deduplication options */}
            <div style={styles.filterSection}>
              <label style={styles.checkboxLabel}>
                <input 
                  type="checkbox" 
                  checked={skipDuplicates} 
                  onChange={(e) => setSkipDuplicates(e.target.checked)}
                  style={styles.checkbox}
                />
                <div>
                  <span style={{ fontWeight: 600, display: "block" }}>Skip Duplicates</span>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", display: "block", marginTop: "2px" }}>
                    Compares filename & size with S3 cache before upload.
                  </span>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Summary Info */}
        <div style={styles.summaryBox}>
          <h4 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", marginBottom: "12px" }}>
            Queue Summary
          </h4>
          <div style={styles.summaryRow}>
            <span>Total Files:</span>
            <span style={{ fontWeight: 600 }}>{stats.total}</span>
          </div>
          <div style={styles.summaryRow}>
            <span>Ready for Upload:</span>
            <span style={{ color: "var(--color-primary)", fontWeight: 600 }}>{stats.ready}</span>
          </div>
          {skipDuplicates && (
            <div style={styles.summaryRow}>
              <span>Skipped (Duplicate):</span>
              <span style={{ color: "var(--color-warning)", fontWeight: 600 }}>{stats.duplicates}</span>
            </div>
          )}
          {filterByDate && (
            <div style={styles.summaryRow}>
              <span>Filtered Out (Date):</span>
              <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{stats.filtered}</span>
            </div>
          )}
          <hr style={{ border: "none", borderTop: "1px solid var(--border-color)", margin: "10px 0" }} />
          <div style={styles.summaryRow}>
            <span>To Upload:</span>
            <span style={{ color: "#fff", fontWeight: 700 }}>{stats.selected} files</span>
          </div>
          <div style={styles.summaryRow}>
            <span>Total Size:</span>
            <span style={{ color: "#fff", fontWeight: 700 }}>{formatSize(stats.size)}</span>
          </div>
        </div>

        {/* Upload Action */}
        <button
          className="btn btn-primary"
          onClick={startBulkUpload}
          disabled={stats.selected === 0 || isUploading}
          style={{ width: "100%", height: "48px", marginTop: "8px" }}
        >
          {isUploading ? (
            <>
              <RefreshCw size={16} className="pulse" style={{ marginRight: "4px" }} />
              Uploading ({activeUploadsCount} active)...
            </>
          ) : (
            <>
              <UploadCloud size={18} />
              Start Bulk Upload ({stats.selected})
            </>
          )}
        </button>

        {queue.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={handleClearQueue}
            disabled={isUploading}
            style={{ width: "100%", marginTop: "12px" }}
          >
            Clear Queue
          </button>
        )}
      </div>

      <div style={styles.mainArea}>
        {/* Drag and Drop Zone */}
        <div
          ref={dragRef}
          style={{
            ...styles.dropzone,
            borderColor: isDragging ? "var(--color-primary)" : "var(--border-color)",
            backgroundColor: isDragging ? "var(--color-primary-dim)" : "rgba(255, 255, 255, 0.01)",
            boxShadow: isDragging ? "var(--color-primary-glow)" : "none",
          }}
          className="glass-panel"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            type="file"
            multiple
            accept="image/*,video/*"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
          <div style={styles.dropzoneContent}>
            <div style={{
              ...styles.dropzoneIconCircle,
              borderColor: isDragging ? "var(--color-primary)" : "var(--border-color)",
              background: isDragging ? "var(--color-primary-dim)" : "rgba(255, 255, 255, 0.03)",
            }}>
              <UploadCloud size={28} color={isDragging ? "var(--color-primary)" : "var(--text-muted)"} />
            </div>
            <h4 style={{ fontSize: "1rem", marginBottom: "6px" }}>
              {isDragging ? "Drop files here" : "Select or Drag Media files"}
            </h4>
            <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", maxWidth: "280px", margin: "0 auto", lineHeight: "1.5", wordBreak: "break-word" }}>
              Supports photos and videos. On mobile, this triggers the native photo library picker.
            </p>
          </div>
        </div>

        {/* Queue List */}
        {queue.length > 0 ? (
          <div style={styles.queueContainer} className="glass-panel">
            <div style={styles.queueHeader}>
              <h4 style={{ fontSize: "0.95rem" }}>Upload Queue ({queue.length})</h4>
              <div style={{ display: "flex", gap: "12px" }}>
                <button 
                  style={styles.linkButton} 
                  onClick={() => handleSelectAll(true)}
                  disabled={isUploading}
                >
                  Select All
                </button>
                <button 
                  style={styles.linkButton} 
                  onClick={() => handleSelectAll(false)}
                  disabled={isUploading}
                >
                  Deselect All
                </button>
              </div>
            </div>

            <div style={styles.queueList}>
              {queue.map((item) => {
                const isVid = item.file.type.startsWith("video/");
                
                return (
                  <div
                    key={item.id}
                    className="queue-item-responsive"
                    style={{
                      ...styles.queueItem,
                      opacity: item.selected ? 1 : 0.55,
                      backgroundColor: item.status === "success" ? "var(--color-success-bg)" :
                                       item.status === "failed" ? "var(--color-danger-bg)" : "transparent"
                    }}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={item.selected}
                      disabled={item.status === "uploading" || item.status === "success" || item.status === "failed"}
                      onChange={() => handleToggleSelect(item.id)}
                      style={{ ...styles.checkbox, marginRight: "10px", flexShrink: 0 }}
                    />

                    {/* Preview Thumbnail */}
                    <div style={styles.thumbnailContainer}>
                      {item.previewUrl ? (
                        <img src={item.previewUrl} alt="preview" style={styles.thumbnail} />
                      ) : isVid ? (
                        <VideoIcon size={18} color="var(--color-primary)" />
                      ) : (
                        <File size={18} color="var(--text-muted)" />
                      )}
                    </div>

                    {/* Meta info */}
                    <div style={styles.itemMeta} className="queue-item-meta-col">
                      <span style={styles.itemName} title={item.name}>{item.name}</span>
                      <div style={styles.itemSubMeta}>
                        <span>{formatSize(item.size)}</span>
                        <span>·</span>
                        <span>{item.lastModifiedDate.toLocaleDateString()}</span>
                      </div>
                    </div>

                    {/* Status Badge & Upload Progress */}
                    <div style={styles.itemStatusContainer} className="queue-item-status-col">
                      {item.status === "uploading" && (
                        <div style={styles.progressContainer}>
                          <span style={styles.progressPercent}>{item.progress}%</span>
                          <div style={styles.progressBarBg}>
                            <div style={{ ...styles.progressBarFill, width: `${item.progress}%` }} />
                          </div>
                        </div>
                      )}
                      {item.status === "ready" && <span className="badge badge-info">Ready</span>}
                      {item.status === "skipped-duplicate" && (
                        <span className="badge badge-warning" title="Matches a file already in S3 (same key & size)">Dupe</span>
                      )}
                      {item.status === "filtered-date" && (
                        <span className="badge" style={{ backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-muted)", border: "1px solid var(--border-color)" }}>
                          Filtered
                        </span>
                      )}
                      {item.status === "success" && (
                        <span className="badge badge-success">
                          <Check size={11} /> Done
                        </span>
                      )}
                      {item.status === "failed" && (
                        <span className="badge badge-danger" title={item.error} style={{ cursor: "help" }}>
                          <AlertCircle size={11} /> Failed
                        </span>
                      )}
                    </div>

                    {/* Remove Action */}
                    <button
                      className="queue-item-delete-col"
                      style={styles.deleteButton}
                      onClick={() => handleRemoveItem(item.id)}
                      disabled={item.status === "uploading" || item.status === "success"}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={styles.emptyQueue} className="glass-panel">
            <ImageIcon size={36} color="var(--text-muted)" style={{ marginBottom: "12px", opacity: 0.5 }} />
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>No files in the upload queue yet.</p>
          </div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    gap: "20px",
    width: "100%",
    flexWrap: "wrap-reverse",
  },
  sidebar: {
    flex: "1 1 280px",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    height: "fit-content",
  },
  mainArea: {
    flex: "3 1 480px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  sectionTitle: {
    fontSize: "0.9rem",
    fontWeight: "600",
    fontFamily: "var(--font-sans)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    borderBottom: "1px solid var(--border-color)",
    paddingBottom: "12px",
    color: "var(--text-primary)",
  },
  filterSection: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    cursor: "pointer",
    fontSize: "0.875rem",
    userSelect: "none",
    color: "var(--text-secondary)",
  },
  checkbox: {
    width: "16px",
    height: "16px",
    borderRadius: "4px",
    accentColor: "var(--color-primary)",
    cursor: "pointer",
    marginTop: "2px",
    flexShrink: 0,
  },
  dateInputs: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    paddingLeft: "26px",
    transition: "opacity var(--transition-fast)",
  },
  inputWrapper: {
    position: "relative",
    width: "100%",
  },
  inputIcon: {
    position: "absolute",
    left: "12px",
    top: "50%",
    transform: "translateY(-50%)",
    color: "var(--text-muted)",
    pointerEvents: "none",
  },
  summaryBox: {
    backgroundColor: "rgba(0, 0, 0, 0.18)",
    border: "1px solid var(--border-color)",
    borderRadius: "var(--radius-md)",
    padding: "14px",
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "0.82rem",
    color: "var(--text-secondary)",
    marginBottom: "7px",
  },
  dropzone: {
    border: "1.5px dashed var(--border-color)",
    borderRadius: "var(--radius-lg)",
    padding: "36px 24px",
    textAlign: "center",
    cursor: "pointer",
    transition: "all var(--transition-normal)",
  },
  dropzoneContent: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  dropzoneIconCircle: {
    width: "58px",
    height: "58px",
    borderRadius: "50%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: "14px",
    border: "1px solid var(--border-color)",
    transition: "all var(--transition-normal)",
  },
  queueContainer: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "480px",
    overflow: "hidden",
  },
  queueHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 18px",
    borderBottom: "1px solid var(--border-color)",
  },
  linkButton: {
    background: "none",
    border: "none",
    color: "var(--color-primary)",
    fontSize: "0.78rem",
    fontWeight: "600",
    cursor: "pointer",
    padding: "2px 4px",
    borderRadius: "4px",
    transition: "opacity var(--transition-fast)",
    fontFamily: "var(--font-sans)",
  },
  queueList: {
    overflowY: "auto",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "5px",
  },
  queueItem: {
    display: "flex",
    alignItems: "center",
    padding: "9px 12px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-color)",
    transition: "all var(--transition-fast)",
  },
  thumbnailContainer: {
    width: "36px",
    height: "36px",
    borderRadius: "var(--radius-sm)",
    background: "rgba(255, 255, 255, 0.03)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    marginRight: "10px",
    flexShrink: 0,
    border: "1px solid var(--border-color)",
  },
  thumbnail: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  itemMeta: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    marginRight: "10px",
  },
  itemName: {
    fontSize: "0.82rem",
    fontWeight: "500",
    color: "var(--text-primary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemSubMeta: {
    display: "flex",
    gap: "6px",
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    marginTop: "2px",
    alignItems: "center",
  },
  itemStatusContainer: {
    display: "flex",
    alignItems: "center",
    marginRight: "8px",
    flexShrink: 0,
  },
  progressContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "3px",
    width: "72px",
  },
  progressPercent: {
    fontSize: "0.72rem",
    fontWeight: "700",
    color: "var(--color-primary)",
    fontFamily: "var(--font-mono)",
  },
  progressBarBg: {
    width: "100%",
    height: "3px",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: "2px",
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "var(--color-primary)",
    borderRadius: "2px",
    transition: "width 0.1s linear",
  },
  deleteButton: {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "5px",
    borderRadius: "5px",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    transition: "all var(--transition-fast)",
    flexShrink: 0,
  },
  emptyQueue: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "52px 24px",
    textAlign: "center",
  },
};
