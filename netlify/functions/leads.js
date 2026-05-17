const https = require('https');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let body = {};
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { city, type, apiKey, limit } = body;
  if (!apiKey) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing API key' }) };
  if (!city) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing city' }) };

  // Foursquare Places Search - new API uses Service Key (starts with "fsq3...")
  const query = encodeURIComponent(type || 'restaurant');
  const near = encodeURIComponent(city);
  const lim = Math.min(parseInt(limit) || 30, 50);
  // Request website field so we can detect leads with no website
  const url = `https://places-api.foursquare.com/places/search?query=${query}&near=${near}&limit=${lim}&fields=fsq_place_id,name,location,tel,website,rating,categories`;

  const fetchUrl = (url, options) => new Promise((resolve, reject) => {
    https.get(url, options || {}, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: { raw: raw.substring(0, 300) } }); }
      });
    }).on('error', reject);
  });

  try {
    // Foursquare new API expects Bearer token + version header
    const result = await fetchUrl(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Places-Api-Version': '2025-06-17',
        'Accept': 'application/json'
      }
    });

    if (result.status !== 200) {
      return { statusCode: 200, headers, body: JSON.stringify({
        error: result.data.message || result.data.raw || `Foursquare returned ${result.status}`,
        status: result.status,
        debug: result.data
      })};
    }

    const places = result.data.results || [];
    const businesses = places.map(p => ({
      id: p.fsq_place_id,
      name: p.name,
      address: p.location?.formatted_address || [p.location?.address, p.location?.locality, p.location?.region].filter(Boolean).join(', '),
      phone: p.tel || 'N/A',
      rating: p.rating || 'N/A',
      website: p.website || null,
      hasWebsite: !!p.website,
      categories: (p.categories || []).map(c => c.name).join(', ')
    }));

    return { statusCode: 200, headers, body: JSON.stringify({
      success: true,
      total: businesses.length,
      businesses
    })};
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
