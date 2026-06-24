import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Download,
  Trash2,
  FileText,
  Calendar,
  HardDrive,
  X,
  Eye,
  Copy,
  Check,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Camera,
  MapPin,
  Clock,
} from "lucide-react";
import { getPresignedReadUrl, deleteS3Object, getObjectMetadata } from "../utils/s3";
import type { S3Credentials, S3MediaItem } from "../utils/s3";
import { getCachedUrl, setCachedUrl } from "../utils/cache";
import type { MetaIndex, MetaEntry } from "../utils/metaIndex";
import { reverseGeocode } from "../utils/geocode";

interface GalleryGridProps {
  creds: S3Credentials;
  items: S3MediaItem[];
  loading: boolean;
  cacheAgeMs: number | null;
  metaIndex: MetaIndex;
  onMetaEnrich: (entries: Record<string, MetaEntry>) => void;
  onRefresh: () => void;
}

const PAGE_SIZE = 40;

// ── Date helpers ──────────────────────────────────────────────────────────────
function effectiveDate(item: S3MediaItem): Date {
  return item.dateTaken
    ? new Date(item.dateTaken)
    : (item.lastModified ?? new Date(0));
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return new Date(parseInt(y), parseInt(m) - 1, 1)
    .toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
// ─────────────────────────────────────────────────────────────────────────────

export const GalleryGrid: React.FC<GalleryGridProps> = ({
  creds, items, loading, cacheAgeMs, metaIndex, onMetaEnrich, onRefresh,
}) => {
  const [filterType, setFilterType] = useState<"all" | "image" | "video" | "other">("all");
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set());
  const [monthDropdownOpen, setMonthDropdownOpen] = useState(false);
  const [itemsGeneration, setItemsGeneration] = useState(0);
  // locationFilter is the immediate input value; debouncedLocation is what the filter logic uses
  const [locationFilter, setLocationFilter] = useState("");
  const [debouncedLocation, setDebouncedLocation] = useState("");
  const [itemsWithUrls, setItemsWithUrls] = useState<S3MediaItem[]>([]);
  const [activeItem, setActiveItem] = useState<S3MediaItem | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [activeExif, setActiveExif] = useState<Record<string, string> | null>(null);
  const [exifLoading, setExifLoading] = useState(false);
  const touchStartX = useRef<number>(0);
  // Session-level EXIF cache — HeadObject is cheap but no need to repeat it
  const exifCacheRef = useRef<Map<string, Record<string, string>>>(new Map());
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Tracks keys currently being signed so we don't double-generate
  const generatingRef = useRef<Set<string>>(new Set());
  const monthDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShowInfoPanel(false);
    setActiveExif(null);
    if (!activeItem) return;

    const cached = exifCacheRef.current.get(activeItem.key);
    if (cached) { setActiveExif(cached); return; }

    setExifLoading(true);
    getObjectMetadata(creds, activeItem.key)
      .then(async meta => {
        exifCacheRef.current.set(activeItem.key, meta);
        setActiveExif(meta);

        // Lazy enrichment: backfill dateTaken + geocode from HeadObject for pre-index photos
        const idxEntry = metaIndex[activeItem.key];
        const lat = meta["gps-lat"] || idxEntry?.gpsLat;
        const lng = meta["gps-lng"] || idxEntry?.gpsLng;
        const dateTakenFromMeta = meta["date-taken"];

        const needsDate = dateTakenFromMeta && !idxEntry?.dateTaken;
        // Also re-geocode if area/street is missing (upgrades entries from older BigDataCloud era)
        const needsGeo  = lat && lng && (!idxEntry?.city || !idxEntry?.area);

        if (needsDate || needsGeo) {
          let geo: { city?: string; country?: string; countryCode?: string; area?: string; street?: string } = {};
          if (needsGeo) geo = await reverseGeocode(lat!, lng!);

          const enriched: MetaEntry = {
            ...idxEntry,
            ...(dateTakenFromMeta ? { dateTaken: dateTakenFromMeta } : {}),
            ...(lat          ? { gpsLat: lat }                 : {}),
            ...(lng          ? { gpsLng: lng }                 : {}),
            ...(geo.city        ? { city: geo.city }           : {}),
            ...(geo.country     ? { country: geo.country }     : {}),
            ...(geo.countryCode ? { countryCode: geo.countryCode } : {}),
            ...(geo.area        ? { area: geo.area }           : {}),
            ...(geo.street      ? { street: geo.street }       : {}),
          };
          onMetaEnrich({ [activeItem.key]: enriched });
        }
      })
      .catch(() => setActiveExif({}))
      .finally(() => setExifLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItem?.key, creds]);

  // When items or metaIndex change, enrich items with date/gps/location from index
  useEffect(() => {
    setItemsWithUrls(items.map(item => {
      const m = metaIndex[item.key];
      return {
        ...item,
        dateTaken:   m?.dateTaken,
        gpsLat:      m?.gpsLat,
        gpsLng:      m?.gpsLng,
        city:        m?.city,
        country:     m?.country,
        countryCode: m?.countryCode,
        area:        m?.area,
        street:      m?.street,
      };
    }));
    generatingRef.current = new Set();
    setItemsGeneration(g => g + 1);
    setVisibleCount(PAGE_SIZE);
    setSelectedMonths(new Set());
    setLocationFilter("");
    setDebouncedLocation("");
  }, [items, metaIndex]);

  // Reset pagination when any filter changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filterType, selectedMonths, debouncedLocation]);

  // Debounce location filter — wait 300ms after last keystroke before filtering
  useEffect(() => {
    const t = setTimeout(() => setDebouncedLocation(locationFilter), 300);
    return () => clearTimeout(t);
  }, [locationFilter]);

  // Close month dropdown when clicking outside
  useEffect(() => {
    if (!monthDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (monthDropdownRef.current && !monthDropdownRef.current.contains(e.target as Node)) {
        setMonthDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [monthDropdownOpen]);

  // Filtered + sorted items — sorted by effective date desc (dateTaken ?? lastModified)
  const filteredItems = useMemo(() => {
    const loc = debouncedLocation.trim().toLowerCase();
    return itemsWithUrls
      .filter(item => {
        const matchesType = filterType === "all" || item.type === filterType;
        const eDate = effectiveDate(item);
        const matchesMonth = selectedMonths.size === 0 || selectedMonths.has(monthKey(eDate));
        const matchesLoc = !loc ||
          item.city?.toLowerCase().includes(loc) ||
          item.country?.toLowerCase().includes(loc) ||
          item.countryCode?.toLowerCase().includes(loc) ||
          item.area?.toLowerCase().includes(loc) ||
          item.street?.toLowerCase().includes(loc);
        return matchesType && matchesMonth && matchesLoc;
      })
      .sort((a, b) => effectiveDate(b).getTime() - effectiveDate(a).getTime());
  }, [itemsWithUrls, filterType, selectedMonths, debouncedLocation]);

  // Unique months across search+type filtered set — intentionally ignores location
  // so the month dropdown stays stable while typing a city name
  const allMonths = useMemo(() => {
    const seen = new Set<string>();
    itemsWithUrls.forEach(item => {
      if (filterType === "all" || item.type === filterType) {
        seen.add(monthKey(effectiveDate(item)));
      }
    });
    return Array.from(seen).sort().reverse();
  }, [itemsWithUrls, filterType]);

  // Visible items grouped by month/year
  const visibleGroups = useMemo(() => {
    const visible = filteredItems.slice(0, visibleCount);
    const map = new Map<string, S3MediaItem[]>();
    visible.forEach(item => {
      const key = monthKey(effectiveDate(item));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    });
    return Array.from(map.entries()).map(([key, groupItems]) => ({
      key,
      label: monthLabel(key),
      items: groupItems,
    }));
  }, [filteredItems, visibleCount]);

  // Stable string of visible keys — used as effect dep so URL generation only
  // re-runs when the visible set changes, NOT when URLs are populated into items.
  // Prefixed with itemsGeneration so the URL effect re-runs after a refresh
  // even when the file list is identical (same keys → same string otherwise).
  const visibleKeys = useMemo(
    () => `${itemsGeneration}\0` + filteredItems.slice(0, visibleCount).map(i => i.key).join("\0"),
    [filteredItems, visibleCount, itemsGeneration]
  );

  // Generate presigned URLs only for currently visible items, on demand.
  // Cache-first: reusing the same URL lets the browser HTTP cache serve the
  // image → zero S3 egress on repeat visits.
  useEffect(() => {
    let active = true;
    const slice = filteredItems.slice(0, visibleCount);
    const todo = slice.filter(
      item => !item.presignedUrl && !generatingRef.current.has(item.key)
    );
    if (todo.length === 0) return;
    todo.forEach(item => generatingRef.current.add(item.key));

    const run = async () => {
      const BATCH = 10;
      for (let i = 0; i < todo.length; i += BATCH) {
        if (!active) break;
        await Promise.all(todo.slice(i, i + BATCH).map(async item => {
          try {
            const cached = getCachedUrl(creds.bucketName, item.key);
            const url = cached ?? await getPresignedReadUrl(creds, item.key);
            if (!cached) setCachedUrl(creds.bucketName, item.key, url);
            if (active) {
              setItemsWithUrls(prev =>
                prev.map(it => it.key === item.key ? { ...it, presignedUrl: url } : it)
              );
            }
          } catch (e) {
            console.error(`Error signing URL for ${item.key}:`, e);
          } finally {
            generatingRef.current.delete(item.key);
          }
        }));
      }
    };

    run();
    return () => { active = false; };
    // visibleKeys is the stable proxy for "which items are visible" —
    // intentionally omitting filteredItems/visibleCount to avoid re-running
    // when URLs populate into itemsWithUrls (keys don't change, only presignedUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKeys, creds]);

  // Infinite scroll: observe a sentinel div at the bottom of the grid
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount(c => Math.min(c + PAGE_SIZE, filteredItems.length));
        }
      },
      { rootMargin: "400px" } // start loading before user hits the bottom
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filteredItems.length]);

  // Format GPS decimal degrees to readable string
  const formatGps = (lat: string, lng: string) => {
    const la = parseFloat(lat), lo = parseFloat(lng);
    return `${Math.abs(la).toFixed(4)}°${la >= 0 ? "N" : "S"}, ${Math.abs(lo).toFixed(4)}°${lo >= 0 ? "E" : "W"}`;
  };

  // Format cache age for display
  const formatCacheAge = (ms: number | null): string => {
    if (ms === null) return "";
    if (ms < 60_000) return "just now";
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
    return `${Math.floor(ms / 3600_000)}h ago`;
  };

  // Format file size
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  // Handle object deletion
  const handleDelete = async (key: string) => {
    if (!window.confirm("Are you sure you want to permanently delete this file from S3?")) return;
    
    setDeletingKey(key);
    try {
      await deleteS3Object(creds, key);
      // Close lightbox if the deleted item was open
      if (activeItem?.key === key) {
        setActiveItem(null);
      }
      onRefresh();
    } catch (e: any) {
      alert(`Error deleting object: ${e.message || e}`);
    } finally {
      setDeletingKey(null);
    }
  };

  // Copy URL to clipboard
  const handleCopyUrl = async (url: string, key: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch (err) {
      console.error("Failed to copy URL:", err);
    }
  };

  // Gallery navigation
  const activeIndex = activeItem ? filteredItems.findIndex(i => i.key === activeItem.key) : -1;
  const canGoPrev = activeIndex > 0;
  const canGoNext = activeIndex < filteredItems.length - 1;

  const handlePrev = useCallback(() => {
    if (activeIndex > 0) setActiveItem(filteredItems[activeIndex - 1]);
  }, [activeIndex, filteredItems]);

  const handleNext = useCallback(() => {
    if (activeIndex < filteredItems.length - 1) setActiveItem(filteredItems[activeIndex + 1]);
  }, [activeIndex, filteredItems]);

  // Keyboard navigation
  useEffect(() => {
    if (!activeItem) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft")  handlePrev();
      if (e.key === "ArrowRight") handleNext();
      if (e.key === "Escape")     setActiveItem(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeItem, handlePrev, handleNext]);

  // Reusable card renderer
  const renderCard = (item: S3MediaItem) => {
    const isImg = item.type === "image";
    const isVid = item.type === "video";
    return (
      <div key={item.key} className="glass-panel media-card-responsive" style={styles.card}>
        <div style={styles.cardMedia} className="media-card-media-responsive" onClick={() => setActiveItem(item)}>
          {item.presignedUrl ? (
            isImg ? (
              <img src={item.presignedUrl} alt={item.name} style={styles.img} loading="lazy" />
            ) : isVid ? (
              <div style={styles.videoThumbnailWrapper}>
                <video src={item.presignedUrl} style={styles.videoPreview} preload="metadata" muted />
                <div style={styles.videoBadge}>VIDEO</div>
              </div>
            ) : (
              <div style={styles.filePlaceholder}>
                <FileText size={40} color="var(--text-muted)" />
                <span style={styles.fileExt}>{item.name.split(".").pop()?.toUpperCase()}</span>
              </div>
            )
          ) : (
            <div style={styles.loaderPlaceholder} className="pulse"><span>Loading…</span></div>
          )}
          <div style={styles.hoverOverlay} className="hover-overlay-effect">
            <Eye size={20} color="#fff" />
          </div>
          {/* Location badge */}
          {(item.city || item.area || item.country) && (
            <div style={styles.gpsBadge} title={[item.street, item.area, item.city, item.country].filter(Boolean).join(", ")}>
              <MapPin size={10} />
              <span style={{ fontSize: "0.65rem", marginLeft: "3px", maxWidth: "90px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.area || item.city || item.country}
              </span>
            </div>
          )}
        </div>

        <div style={styles.cardInfo}>
          <div style={styles.cardHeader}>
            <span style={styles.cardName} title={item.name}>{item.name}</span>
            <span style={styles.cardSize}>{formatSize(item.size)}</span>
          </div>
          <div style={styles.cardFooter}>
            <span style={styles.cardDate}>
              {item.dateTaken
                ? new Date(item.dateTaken).toLocaleDateString()
                : item.lastModified?.toLocaleDateString() ?? "—"}
            </span>
            <div style={styles.cardActions}>
              {item.presignedUrl && (
                <>
                  <button
                    className="btn btn-secondary btn-icon-only"
                    style={styles.actionBtn}
                    onClick={() => handleCopyUrl(item.presignedUrl!, item.key)}
                    title="Copy Secure Link"
                  >
                    {copiedKey === item.key ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
                  </button>
                  <a
                    href={item.presignedUrl}
                    download={item.name}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary btn-icon-only"
                    style={styles.actionBtn}
                    title="Download File"
                  >
                    <Download size={14} />
                  </a>
                </>
              )}
              <button
                className="btn btn-danger btn-icon-only"
                style={styles.actionBtn}
                onClick={() => handleDelete(item.key)}
                disabled={deletingKey === item.key}
                title="Delete Permanently"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={styles.container}>
      {/* Control Bar — month, location, type filters, cache label */}
      <div style={styles.controlBar} className="glass-panel">
        {/* Month dropdown */}
        <div ref={monthDropdownRef} style={styles.monthDropdownWrap}>
          <button
            className={`btn ${selectedMonths.size > 0 ? "btn-primary" : "btn-secondary"}`}
            style={styles.monthDropdownBtn}
            onClick={() => setMonthDropdownOpen(o => !o)}
          >
            <Calendar size={13} />
            <span style={{ flex: 1 }}>
              {selectedMonths.size === 0
                ? "All months"
                : selectedMonths.size === 1
                  ? monthLabel(Array.from(selectedMonths)[0])
                  : `${selectedMonths.size} months`}
            </span>
            <ChevronDown
              size={12}
              style={{
                transition: "transform 0.15s",
                transform: monthDropdownOpen ? "rotate(180deg)" : "none",
                opacity: 0.6,
                flexShrink: 0,
              }}
            />
          </button>
          {monthDropdownOpen && (
            <div style={styles.monthDropdownPanel}>
              {allMonths.length === 0 ? (
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", padding: "6px 10px" }}>No months yet</span>
              ) : allMonths.map(month => {
                const isSelected = selectedMonths.has(month);
                return (
                  <div
                    key={month}
                    style={{
                      ...styles.monthDropdownItem,
                      background: isSelected ? "rgba(34,211,238,0.13)" : "transparent",
                      color: isSelected ? "var(--color-primary)" : "var(--text-secondary)",
                      fontWeight: isSelected ? 600 : 400,
                    }}
                    onClick={() => {
                      setSelectedMonths(prev => {
                        const next = new Set(prev);
                        next.has(month) ? next.delete(month) : next.add(month);
                        return next;
                      });
                    }}
                  >
                    <span style={{ flex: 1 }}>{monthLabel(month)}</span>
                    {isSelected && <Check size={12} style={{ flexShrink: 0, opacity: 0.85 }} />}
                  </div>
                );
              })}
              {selectedMonths.size > 0 && (
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: "6px", width: "100%", fontSize: "0.75rem", height: "30px", minHeight: "unset" }}
                  onClick={() => { setSelectedMonths(new Set()); setMonthDropdownOpen(false); }}
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
        </div>

        {/* Location filter */}
        <div style={{ ...styles.locationInputWrap, flex: "1 1 140px" }}>
          <MapPin size={12} style={styles.locationIcon} />
          <input
            type="text"
            placeholder="City, area or street…"
            value={locationFilter}
            onChange={e => setLocationFilter(e.target.value)}
            className="form-input"
            style={{ ...styles.locationInput, width: "100%" }}
            autoComplete="off"
          />
          {locationFilter && (
            <button
              style={styles.locationClear}
              onClick={() => { setLocationFilter(""); setDebouncedLocation(""); }}
              title="Clear location filter"
            >
              ×
            </button>
          )}
        </div>

        {/* Type filter */}
        <div style={styles.filterGroup} className="filter-group-scroll">
          {(["all", "image", "video", "other"] as const).map((type) => (
            <button
              key={type}
              className={`btn ${filterType === type ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setFilterType(type)}
              style={styles.filterBtn}
            >
              {type === "all" ? "All" : type === "image" ? "Photos" : type === "video" ? "Videos" : "Files"}
            </button>
          ))}
        </div>

        {cacheAgeMs !== null && !loading && (
          <span style={styles.cacheLabel} title="Served from local cache. Click Refresh for live S3 data.">
            ⚡ cached · {formatCacheAge(cacheAgeMs)}
          </span>
        )}
      </div>

      {/* Loading state */}
      {loading ? (
        <div style={styles.centerBox} className="glass-panel">
          <div className="pulse" style={{ fontSize: "1.5rem", color: "var(--color-primary)" }}>● ● ●</div>
          <p style={{ marginTop: "12px", color: "var(--text-secondary)" }}>Scanning S3 Bucket…</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div style={styles.centerBox} className="glass-panel animate-fade-in">
          <AlertCircle size={36} color="var(--text-muted)" style={{ opacity: 0.5 }} />
          <p style={{ marginTop: "12px", color: "var(--text-secondary)" }}>
            {items.length === 0
              ? "No objects found in this S3 Bucket / Prefix."
              : "No files match your filters."}
          </p>
          {(selectedMonths.size > 0 || locationFilter) && (
            <button
              className="btn btn-secondary"
              style={{ marginTop: "12px" }}
              onClick={() => { setSelectedMonths(new Set()); setLocationFilter(""); setDebouncedLocation(""); }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        /* Grouped media grid */
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
          {visibleGroups.map(group => (
            <div key={group.key}>
              <div style={styles.groupHeader}>
                <span style={styles.groupLabel}>{group.label}</span>
                <span style={styles.groupCount}>{group.items.length} {group.items.length === 1 ? "file" : "files"}</span>
              </div>
              <div style={styles.grid} className="media-grid-responsive">
                {group.items.map(renderCard)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Infinite scroll sentinel + progress */}
      {!loading && filteredItems.length > 0 && (
        <div ref={sentinelRef} style={styles.sentinel}>
          {visibleCount < filteredItems.length ? (
            <div className="pulse" style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
              Loading more…
            </div>
          ) : (
            <span style={styles.endLabel}>
              {filteredItems.length} {filteredItems.length === 1 ? "file" : "files"}
            </span>
          )}
        </div>
      )}

      {/* Lightbox / Media Modal — full-screen on mobile, centered panel on desktop */}
      {activeItem && (
        <div className="lightbox-overlay" onClick={() => setActiveItem(null)}>
          <div
            className="lightbox-modal glass-panel animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const diff = touchStartX.current - e.changedTouches[0].clientX;
              if (Math.abs(diff) > 48) diff > 0 ? handleNext() : handlePrev();
            }}
          >
            {/* Header */}
            <div className="lightbox-header">
              <div className="lightbox-header-title">
                <span style={styles.modalTitle} title={activeItem.name}>{activeItem.name}</span>
                <span style={styles.modalSubtitle} className="lightbox-subtitle-dk">{activeItem.key}</span>
              </div>
              {filteredItems.length > 1 && (
                <span style={styles.navCounter}>{activeIndex + 1} / {filteredItems.length}</span>
              )}
              {/* ⋯ info button — mobile only */}
              <button
                className="btn btn-secondary btn-icon-only lightbox-more-btn"
                onClick={(e) => { e.stopPropagation(); setShowInfoPanel(p => !p); }}
                title="File info & actions"
              >
                <MoreHorizontal size={18} />
              </button>
              <button style={styles.modalCloseBtn} onClick={() => setActiveItem(null)}>
                <X size={18} />
              </button>
            </div>

            {/* Body: full-height media + desktop sidebar */}
            <div className="lightbox-body">
              {/* Media area fills all available height */}
              <div className="lightbox-media">
                {canGoPrev && (
                  <button
                    style={{ ...styles.navBtn, left: "10px" }}
                    onClick={(e) => { e.stopPropagation(); handlePrev(); }}
                    aria-label="Previous"
                  >
                    <ChevronLeft size={20} />
                  </button>
                )}

                {activeItem.presignedUrl ? (
                  activeItem.type === "image" ? (
                    <img src={activeItem.presignedUrl} alt={activeItem.name} className="lightbox-img" />
                  ) : activeItem.type === "video" ? (
                    <video src={activeItem.presignedUrl} className="lightbox-video" controls autoPlay />
                  ) : (
                    <div style={styles.modalFileFallback}>
                      <FileText size={56} color="var(--text-muted)" style={{ marginBottom: "14px" }} />
                      <p style={{ color: "var(--text-secondary)", marginBottom: "18px", fontSize: "0.875rem" }}>
                        Preview not available for this file type.
                      </p>
                      <a href={activeItem.presignedUrl} className="btn btn-primary" target="_blank" rel="noreferrer">
                        <Download size={15} /> Download ({formatSize(activeItem.size)})
                      </a>
                    </div>
                  )
                ) : (
                  <div className="pulse" style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                    Generating secure link…
                  </div>
                )}

                {canGoNext && (
                  <button
                    style={{ ...styles.navBtn, right: "10px" }}
                    onClick={(e) => { e.stopPropagation(); handleNext(); }}
                    aria-label="Next"
                  >
                    <ChevronRight size={20} />
                  </button>
                )}
              </div>

              {/* Desktop sidebar — hidden on mobile, shown on desktop */}
              <div className="lightbox-sidebar-panel">
                {/* ── File section ── */}
                <h4 style={styles.sidebarSectionTitle}>File</h4>
                <div style={styles.metaInfoList}>
                  <div style={styles.metaRow}>
                    <HardDrive size={14} color="var(--text-muted)" />
                    <div style={styles.metaValCol}>
                      <span style={styles.metaLabel}>Size</span>
                      <span style={styles.metaValue}>{formatSize(activeItem.size)}</span>
                    </div>
                  </div>
                  <div style={styles.metaRow}>
                    <Calendar size={14} color="var(--text-muted)" />
                    <div style={styles.metaValCol}>
                      <span style={styles.metaLabel}>Modified</span>
                      <span style={styles.metaValue}>
                        {activeItem.lastModified ? activeItem.lastModified.toLocaleString() : "Unknown"}
                      </span>
                    </div>
                  </div>
                  <div style={styles.metaRow}>
                    <FileText size={14} color="var(--text-muted)" />
                    <div style={styles.metaValCol}>
                      <span style={styles.metaLabel}>Type</span>
                      <span style={{ ...styles.metaValue, textTransform: "uppercase" }}>{activeItem.type}</span>
                    </div>
                  </div>
                </div>

                {/* ── Photo Info section (EXIF) ── */}
                {exifLoading ? (
                  <p style={styles.exifLoading}>Loading photo info…</p>
                ) : activeExif && (activeExif["date-taken"] || activeExif["camera-make"] || activeExif["camera-model"] || activeExif["gps-lat"]) ? (
                  <>
                    <h4 style={styles.sidebarSectionTitle}>Photo Info</h4>
                    <div style={styles.metaInfoList}>
                      {activeExif["date-taken"] && (
                        <div style={styles.metaRow}>
                          <Clock size={14} color="var(--text-muted)" />
                          <div style={styles.metaValCol}>
                            <span style={styles.metaLabel}>Date Taken</span>
                            <span style={styles.metaValue}>
                              {new Date(activeExif["date-taken"]).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      )}
                      {(activeExif["camera-make"] || activeExif["camera-model"]) && (
                        <div style={styles.metaRow}>
                          <Camera size={14} color="var(--text-muted)" />
                          <div style={styles.metaValCol}>
                            <span style={styles.metaLabel}>Camera</span>
                            <span style={styles.metaValue}>
                              {[activeExif["camera-make"], activeExif["camera-model"]].filter(Boolean).join(" ")}
                            </span>
                          </div>
                        </div>
                      )}
                      {activeExif["gps-lat"] && activeExif["gps-lng"] && (
                        <div style={styles.metaRow}>
                          <MapPin size={14} color="var(--text-muted)" />
                          <div style={styles.metaValCol}>
                            <span style={styles.metaLabel}>Location</span>
                            {activeItem.street && (
                              <span style={styles.metaValue}>{activeItem.street}</span>
                            )}
                            {activeItem.area && (
                              <span style={styles.metaValue}>{activeItem.area}</span>
                            )}
                            {(activeItem.city || activeItem.country) && (
                              <span style={styles.metaValue}>
                                {[activeItem.city, activeItem.country].filter(Boolean).join(", ")}
                              </span>
                            )}
                            <a
                              href={`https://maps.google.com/?q=${activeExif["gps-lat"]},${activeExif["gps-lng"]}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ ...styles.metaValue, color: "var(--color-primary)", textDecoration: "none", marginTop: "4px", fontSize: "0.75rem" }}
                            >
                              {formatGps(activeExif["gps-lat"], activeExif["gps-lng"])} ↗
                            </a>
                            {activeExif["gps-altitude"] && (
                              <span style={{ ...styles.metaValue, marginTop: "2px", fontSize: "0.72rem", opacity: 0.7 }}>
                                {parseFloat(activeExif["gps-altitude"]).toFixed(0)} m altitude
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : activeExif !== null ? (
                  <p style={styles.corsHint}>
                    No photo info. Add <code style={styles.corsHintCode}>x-amz-meta-*</code> to <em>ExposeHeaders</em> in your S3 CORS config, then re-upload.
                  </p>
                ) : null}

                {/* ── Actions ── */}
                <div style={styles.modalControls}>
                  {activeItem.presignedUrl && (
                    <>
                      <button
                        className="btn btn-secondary"
                        style={{ width: "100%" }}
                        onClick={() => handleCopyUrl(activeItem.presignedUrl!, activeItem.key)}
                      >
                        {copiedKey === activeItem.key
                          ? <><Check size={15} color="var(--color-success)" /><span>Copied!</span></>
                          : <><Copy size={15} /><span>Copy Link</span></>}
                      </button>
                      <a
                        href={activeItem.presignedUrl}
                        download={activeItem.name}
                        className="btn btn-primary"
                        style={{ width: "100%" }}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Download size={15} /><span>Download</span>
                      </a>
                    </>
                  )}
                  <button
                    className="btn btn-danger"
                    style={{ width: "100%" }}
                    onClick={() => handleDelete(activeItem.key)}
                    disabled={deletingKey === activeItem.key}
                  >
                    <Trash2 size={15} /><span>Delete</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Mobile bottom sheet backdrop */}
            {showInfoPanel && (
              <div
                className="lightbox-sheet-backdrop"
                onClick={(e) => { e.stopPropagation(); setShowInfoPanel(false); }}
              />
            )}

            {/* Mobile bottom sheet — slides up from bottom */}
            <div className={`lightbox-sheet${showInfoPanel ? " open" : ""}`} onClick={(e) => e.stopPropagation()}>
              <div className="lightbox-sheet-handle" />

              {/* File section */}
              <h4 style={styles.sidebarSectionTitle}>File</h4>
              <div style={styles.metaInfoList}>
                <div style={styles.metaRow}>
                  <HardDrive size={14} color="var(--text-muted)" />
                  <div style={styles.metaValCol}>
                    <span style={styles.metaLabel}>Size</span>
                    <span style={styles.metaValue}>{formatSize(activeItem.size)}</span>
                  </div>
                </div>
                <div style={styles.metaRow}>
                  <Calendar size={14} color="var(--text-muted)" />
                  <div style={styles.metaValCol}>
                    <span style={styles.metaLabel}>Modified</span>
                    <span style={styles.metaValue}>
                      {activeItem.lastModified ? activeItem.lastModified.toLocaleString() : "Unknown"}
                    </span>
                  </div>
                </div>
                <div style={styles.metaRow}>
                  <FileText size={14} color="var(--text-muted)" />
                  <div style={styles.metaValCol}>
                    <span style={styles.metaLabel}>Type</span>
                    <span style={{ ...styles.metaValue, textTransform: "uppercase" }}>{activeItem.type}</span>
                  </div>
                </div>
              </div>

              {/* Photo Info section (EXIF) */}
              {exifLoading ? (
                <p style={styles.exifLoading}>Loading photo info…</p>
              ) : activeExif && (activeExif["date-taken"] || activeExif["camera-make"] || activeExif["camera-model"] || activeExif["gps-lat"]) ? (
                <>
                  <h4 style={styles.sidebarSectionTitle}>Photo Info</h4>
                  <div style={styles.metaInfoList}>
                    {activeExif["date-taken"] && (
                      <div style={styles.metaRow}>
                        <Clock size={14} color="var(--text-muted)" />
                        <div style={styles.metaValCol}>
                          <span style={styles.metaLabel}>Date Taken</span>
                          <span style={styles.metaValue}>
                            {new Date(activeExif["date-taken"]).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    )}
                    {(activeExif["camera-make"] || activeExif["camera-model"]) && (
                      <div style={styles.metaRow}>
                        <Camera size={14} color="var(--text-muted)" />
                        <div style={styles.metaValCol}>
                          <span style={styles.metaLabel}>Camera</span>
                          <span style={styles.metaValue}>
                            {[activeExif["camera-make"], activeExif["camera-model"]].filter(Boolean).join(" ")}
                          </span>
                        </div>
                      </div>
                    )}
                    {activeExif["gps-lat"] && activeExif["gps-lng"] && (
                      <div style={styles.metaRow}>
                        <MapPin size={14} color="var(--text-muted)" />
                        <div style={styles.metaValCol}>
                          <span style={styles.metaLabel}>Location</span>
                          <a
                            href={`https://maps.google.com/?q=${activeExif["gps-lat"]},${activeExif["gps-lng"]}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ ...styles.metaValue, color: "var(--color-primary)", textDecoration: "none" }}
                          >
                            {formatGps(activeExif["gps-lat"], activeExif["gps-lng"])}
                          </a>
                          {activeExif["gps-altitude"] && (
                            <span style={{ ...styles.metaValue, marginTop: "2px" }}>
                              {parseFloat(activeExif["gps-altitude"]).toFixed(0)} m altitude
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : activeExif !== null ? (
                <p style={styles.corsHint}>
                  No photo info. Add <code style={styles.corsHintCode}>x-amz-meta-*</code> to <em>ExposeHeaders</em> in your S3 CORS config, then re-upload.
                </p>
              ) : null}

              {/* Actions */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {activeItem.presignedUrl && (
                  <>
                    <button
                      className="btn btn-secondary"
                      style={{ width: "100%" }}
                      onClick={() => handleCopyUrl(activeItem.presignedUrl!, activeItem.key)}
                    >
                      {copiedKey === activeItem.key
                        ? <><Check size={15} color="var(--color-success)" /><span>Copied!</span></>
                        : <><Copy size={15} /><span>Copy Link</span></>}
                    </button>
                    <a
                      href={activeItem.presignedUrl}
                      download={activeItem.name}
                      className="btn btn-primary"
                      style={{ width: "100%" }}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download size={15} /><span>Download</span>
                    </a>
                  </>
                )}
                <button
                  className="btn btn-danger"
                  style={{ width: "100%" }}
                  onClick={() => { setShowInfoPanel(false); handleDelete(activeItem.key); }}
                  disabled={deletingKey === activeItem.key}
                >
                  <Trash2 size={15} /><span>Delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    width: "100%",
  },
  controlBar: {
    display: "flex",
    alignItems: "center",
    padding: "10px 14px",
    gap: "10px",
    flexWrap: "wrap" as const,
    position: "relative" as const,
    zIndex: 10,
  },
  filterGroup: {
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
    flexShrink: 0,
  },
  filterBtn: {
    padding: "7px 14px",
    fontSize: "0.82rem",
    minHeight: "unset",
    height: "36px",
  },
  cacheLabel: {
    fontSize: "0.7rem",
    fontFamily: "var(--font-mono)",
    color: "var(--color-success)",
    opacity: 0.7,
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  sentinel: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "32px 0 48px",
    width: "100%",
  },
  endLabel: {
    fontSize: "0.72rem",
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
    opacity: 0.5,
  },
  centerBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "56px 24px",
    textAlign: "center",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "16px",
    width: "100%",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    transition: "transform var(--transition-fast), box-shadow var(--transition-fast)",
  },
  cardMedia: {
    width: "100%",
    height: "168px",
    background: "rgba(0, 0, 0, 0.4)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
    cursor: "pointer",
    overflow: "hidden",
    borderBottom: "1px solid var(--border-color)",
  },
  img: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    transition: "transform var(--transition-normal)",
  },
  videoThumbnailWrapper: {
    width: "100%",
    height: "100%",
    position: "relative",
  },
  videoPreview: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  videoBadge: {
    position: "absolute",
    top: "8px",
    right: "8px",
    background: "rgba(124, 58, 237, 0.88)",
    color: "#fff",
    fontSize: "0.62rem",
    fontWeight: "700",
    fontFamily: "var(--font-mono)",
    padding: "2px 6px",
    borderRadius: "4px",
    letterSpacing: "0.04em",
  },
  filePlaceholder: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "8px",
  },
  fileExt: {
    fontSize: "0.72rem",
    fontWeight: "700",
    fontFamily: "var(--font-mono)",
    color: "var(--text-secondary)",
    background: "rgba(255,255,255,0.05)",
    padding: "2px 7px",
    borderRadius: "4px",
  },
  loaderPlaceholder: {
    fontSize: "0.82rem",
    color: "var(--text-muted)",
  },
  hoverOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    background: "rgba(7, 9, 14, 0.4)",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    opacity: 0,
    transition: "opacity var(--transition-fast)",
  },
  cardInfo: {
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "10px",
  },
  cardName: {
    fontSize: "0.8rem",
    fontWeight: "500",
    color: "var(--text-primary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
  },
  cardSize: {
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    flexShrink: 0,
    fontFamily: "var(--font-mono)",
  },
  cardFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
  },
  cardDate: {
    fontSize: "0.72rem",
    color: "var(--text-muted)",
  },
  cardActions: {
    display: "flex",
    gap: "3px",
  },
  actionBtn: {
    padding: "5px",
    borderRadius: "6px",
    minHeight: "unset",
    height: "28px",
    width: "28px",
  },

  /* Lightbox Modal — layout handled by CSS classes, only non-responsive styles here */
  modalTitle: {
    fontSize: "0.9rem",
    fontWeight: "600",
    color: "var(--text-primary)",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  modalSubtitle: {
    fontSize: "0.7rem",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    marginTop: "2px",
  },
  modalCloseBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "6px",
    borderRadius: "var(--radius-sm)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all var(--transition-fast)",
    flexShrink: 0,
  },
  navBtn: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    cursor: "pointer",
    backdropFilter: "blur(6px)",
    transition: "all 0.13s ease",
  },
  navCounter: {
    fontSize: "0.72rem",
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
    marginLeft: "auto",
    paddingRight: "10px",
    flexShrink: 0,
    whiteSpace: "nowrap" as const,
  },
  modalFileFallback: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
  },
  sidebarSectionTitle: {
    fontSize: "0.72rem",
    fontWeight: "600",
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--border-color)",
    paddingBottom: "8px",
    marginTop: "4px",
    fontFamily: "var(--font-sans)",
  },
  exifLoading: {
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    margin: "8px 0 0",
    opacity: 0.6,
  },
  corsHint: {
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    lineHeight: "1.5",
    margin: "10px 0 0",
    opacity: 0.75,
  },
  corsHintCode: {
    fontFamily: "var(--font-mono)",
    background: "rgba(255,255,255,0.06)",
    padding: "1px 4px",
    borderRadius: "3px",
    fontSize: "0.7rem",
  },

  // Month dropdown
  monthDropdownWrap: {
    position: "relative" as const,
    flexShrink: 0,
  },
  monthDropdownBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 12px",
    fontSize: "0.75rem",
    height: "32px",
    minHeight: "unset",
    minWidth: "140px",
    whiteSpace: "nowrap" as const,
  },
  monthDropdownPanel: {
    position: "absolute" as const,
    top: "calc(100% + 6px)",
    left: 0,
    zIndex: 9999,
    background: "rgba(10, 14, 23, 0.97)",
    backdropFilter: "blur(20px)",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: "var(--radius-md)",
    padding: "6px",
    minWidth: "190px",
    maxHeight: "280px",
    overflowY: "auto" as const,
    boxShadow: "0 16px 40px rgba(0,0,0,0.65), 0 2px 8px rgba(0,0,0,0.4)",
    display: "flex",
    flexDirection: "column" as const,
    gap: "1px",
  },
  monthDropdownItem: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.8rem",
    transition: "background 0.1s, color 0.1s",
    userSelect: "none" as const,
  },

  // Group headers
  groupHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    marginBottom: "14px",
    paddingBottom: "8px",
    borderBottom: "1px solid var(--border-color)",
  },
  groupLabel: {
    fontSize: "1rem",
    fontWeight: "700",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
  },
  groupCount: {
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
  },

  // Location badge on card thumbnail
  gpsBadge: {
    position: "absolute" as const,
    bottom: "6px",
    left: "6px",
    background: "rgba(0,0,0,0.45)",
    color: "#ffffff",
    borderRadius: "4px",
    padding: "2px 6px",
    display: "flex",
    alignItems: "center",
    backdropFilter: "blur(6px)",
    border: "1px solid rgba(255,255,255,0.15)",
    maxWidth: "calc(100% - 12px)",
  },

  // Location filter input in timeline strip
  locationInputWrap: {
    position: "relative" as const,
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  locationIcon: {
    position: "absolute" as const,
    left: "9px",
    color: "var(--text-muted)",
    pointerEvents: "none" as const,
    zIndex: 1,
  },
  locationInput: {
    paddingLeft: "28px",
    paddingRight: "28px",
    height: "30px",
    minHeight: "unset",
    fontSize: "0.75rem",
    width: "160px",
    borderRadius: "var(--radius-sm)",
  },
  locationClear: {
    position: "absolute" as const,
    right: "8px",
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: "1rem",
    lineHeight: 1,
    padding: 0,
    display: "flex",
    alignItems: "center",
  },
  metaInfoList: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  metaRow: {
    display: "flex",
    gap: "10px",
    alignItems: "flex-start",
  },
  metaValCol: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  metaLabel: {
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  metaValue: {
    fontSize: "0.82rem",
    color: "var(--text-secondary)",
    wordBreak: "break-all",
    marginTop: "2px",
    fontFamily: "var(--font-mono)",
  },
  modalControls: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    marginTop: "auto",
    paddingTop: "16px",
    borderTop: "1px solid var(--border-color)",
  },
};
