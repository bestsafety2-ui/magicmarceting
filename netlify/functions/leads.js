const https = require('https');

const get = (url, headers) => new Promise((resolve, reject) => {
  https.get(url, { headers: headers || { 'User-Agent': 'MagicMARCeting/1.0' } }, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
      catch(e) { resolve({ status: res.statusCode, data: { raw: raw.substring(0, 300) } }); }
    });
  }).on('error', reject);
});

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  let body = {};
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {}); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { city, type } = body;
  if (!city) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing city' }) };

  const typeMap = {
    'restaurant': 'amenity=restaurant',
    'salon': 'shop=hairdresser',
    'gym': 'leisure=fitness_centre',
    'contractor': 'craft=construction',
    'realtor': 'office=estate_agent',
    'retail': 'shop=clothes',
    'food truck': 'amenity=fast_food',
    'cleaning service': 'shop=cleaning',
    'dentist': 'amenity=dentist',
    'auto repair': 'shop=car_repair'
  };

  const osmTag = typeMap[type] || 'amenity=restaurant';
  const [tagKey, tagVal] = osmTag.split('=');

  try {
    // Step 1: Geocode city using Nominatim
    const geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`;
    const geo = await get(geocodeUrl, { 'User-Agent': 'MagicMARCeting/1.0', 'Accept': 'application/json' });

    if (!geo.data || !geo.data[0]) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: `Could not find city: ${city}. Try just the city name like "Miami" or "Chicago".` }) };
    }

    const { lat, lon, display_name } = geo.data[0];

    // Step 2: Search Overpass by coordinates (15km radius)
    const query = `[out:json][timeout:30];(node["${tagKey}"="${tagVal}"](around:15000,${lat},${lon});way["${tagKey}"="${tagVal}"](around:15000,${lat},${lon}););out body 50;`;
    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const result = await get(overpassUrl);

    if (result.status !== 200 || !result.data.elements) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: `OpenStreetMap search failed. Try again in a moment.` }) };
    }

    const seen = new Set();
    const businesses = [];

    for (const el of result.data.elements) {
      const tags = el.tags || {};
      const name = tags.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const website = tags.website || tags['contact:website'] || null;
      const phone = tags.phone || tags['contact:phone'] || tags['contact:mobile'] || 'N/A';
      const addr = [
        tags['addr:housenumber'],
        tags['addr:street'],
        tags['addr:city']
      ].filter(Boolean).join(' ') || city;

      businesses.push({
        name,
        address: addr,
        phone,
        website,
        hasWebsite: !!website,
        rating: 'N/A',
        categories: type
      });

      if (businesses.length >= 30) break;
    }

    if (!businesses.length) {
      return { statusCode: 200, headers, body: JSON.stringify({
        error: `No ${type}s found near ${city}. OSM data may be limited for this area. Try a larger city.`
      })};
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, total: businesses.length, businesses }) };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
