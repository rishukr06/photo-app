export interface GeoResult {
  city?: string;
  country?: string;
  countryCode?: string;
  area?: string;    // neighbourhood / suburb / district
  street?: string;  // road / pedestrian street name
}

// In-memory cache keyed by lat/lng rounded to 3 decimal places (~110 m precision)
const cache = new Map<string, GeoResult>();

/**
 * Reverse-geocodes GPS coordinates using Nominatim (OpenStreetMap).
 * Returns city, country, neighbourhood/area, and road/street.
 * Free, CORS-enabled, no API key. Silently returns {} on any error.
 */
export async function reverseGeocode(lat: string, lng: string): Promise<GeoResult> {
  const key = `${parseFloat(lat).toFixed(3)},${parseFloat(lng).toFixed(3)}`;
  if (cache.has(key)) return cache.get(key)!;

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1`,
      { headers: { "Accept-Language": "en" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const addr = data.address ?? {};

    const result: GeoResult = {
      city:        addr.city || addr.town || addr.village || addr.municipality || addr.county,
      country:     addr.country,
      countryCode: addr.country_code?.toUpperCase(),
      area:        addr.neighbourhood || addr.suburb || addr.quarter || addr.borough || addr.district,
      street:      addr.road || addr.pedestrian || addr.path || addr.footway,
    };

    // Strip undefined keys so the object stays clean
    (Object.keys(result) as (keyof GeoResult)[]).forEach(k => {
      if (!result[k]) delete result[k];
    });

    cache.set(key, result);
    return result;
  } catch {
    return {};
  }
}
