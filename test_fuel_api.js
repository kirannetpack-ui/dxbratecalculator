const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3000' + path, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch(e) {
          resolve(d);
        }
      });
    }).on('error', reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch(e) {
          resolve(d);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('--- 1. Testing GET /api/fuel-surcharges ---');
  const surcharges = await get('/api/fuel-surcharges');
  console.log('Aramex Rate:', surcharges.aramex.ratePercent + '%', '| URL:', surcharges.aramex.url);
  console.log('UPS Rate:', surcharges.ups.ratePercent + '%', '| URL:', surcharges.ups.url);
  console.log('Status:', surcharges.aramex.status);

  console.log('\n--- 2. Testing POST /api/fuel-surcharges/sync ---');
  const syncRes = await post('/api/fuel-surcharges/sync', {});
  console.log('Sync message:', syncRes.message);
  console.log('Aramex Probe Status:', syncRes.report.aramex.probeStatus);
  console.log('UPS Probe Status:', syncRes.report.ups.probeStatus);

  console.log('\n--- 3. Testing POST /api/calculate with Live Surcharges ---');
  const calcRes = await post('/api/calculate', { destination: 'SA', actualWeight: 20 });
  console.log('Chargeable Weight:', calcRes.shipment.weight.chargeableKg, 'kg');
  console.log('Aramex Total NPR:', calcRes.carriers.aramex.grandTotalNPR, '| Surcharges NPR:', calcRes.carriers.aramex.totalSurchargesNPR);
  console.log('UPS Total NPR:', calcRes.carriers.ups.grandTotalNPR, '| Surcharges NPR:', calcRes.carriers.ups.totalSurchargesNPR);
  console.log('Attached Fuel Surcharge Info:', calcRes.fuelSurcharges);

  console.log('\n--- 4. Testing POST /api/fuel-surcharges/update (Override / Circular) ---');
  const updateRes = await post('/api/fuel-surcharges/update', {
    carrier: 'aramex',
    ratePercent: 14.5,
    note: 'Verified against Aramex Dubai circular'
  });
  console.log('Update success:', updateRes.success, 'New Rate:', updateRes.newRate + '%');
}

run().catch(console.error);
