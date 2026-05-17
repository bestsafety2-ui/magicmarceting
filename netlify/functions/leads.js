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

  const query = encodeURIComponent(type || 'restaurant');
  const near = encodeURIComponent(city);
  const lim = Math.min(parseInt(limit) || 30, 50);

  const url = `https://api.foursquare.com/v3/places/search?query=${query}&near=${near}&limit=${lim}&fields=fsq_id,name,location,tel,website,rating,categories`;

  const fetchData = (url) => new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Authorization': apiKey,
        'Accept': 'application/json'
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: { raw: raw.substring(0, 500) } }); }
      });
    }).on('error', reject);
  });

  try {
    const result = await fetchData(url);

    if (result.status !== 200) {
      return { statusCode: 200, headers, body: JSON.stringify({
        error: result.data.message || JSON.stringify(result.data) || `API error: ${result.status}`,
        debug: result.data
      })};
    }

    const results = result.data.results || [];

    const businesses = results.map(p => ({
      name: p.name,
      address: [p.location?.address, p.location?.locality, p.location?.region].filter(Boolean).join(', ') || '',
      phone: p.tel || 'N/A',
      rating: p.rating ? (p.rating / 2).toFixed(1) : 'N/A',
      categories: (p.categories || []).map(c => c.name).join(', '),
      hasWebsite: !!p.website,
      website: p.website || null
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
