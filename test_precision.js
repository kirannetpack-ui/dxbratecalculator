const http = require('http');

function test(dest, weight) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      actualWeight: weight,
      dimL: 40, dimW: 35, dimH: 30,
      destination: dest,
      airlineId: 'flydubai',
      slab: '300'
    });

    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/calculate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('Testing GCC Destination (Saudi Arabia - 20kg):');
  const sa = await test('SA', 20.0);
  console.log('  Chargeable Weight:', sa.shipment.weight.chargeableKg, 'kg');
  console.log('  Air Cargo (NPR):', sa.linehaul.amountNPR);
  console.log('  Dubai Clearance (NPR):', sa.dubaiAgencyClearance.amountNPR, `(AED ${sa.dubaiAgencyClearance.amountAED})`);
  console.log('  Aramex Available:', sa.carriers.aramex.available, '| Total NPR:', sa.carriers.aramex.grandTotalNPR, `| Base AED: ${sa.carriers.aramex.baseFreightAED}`);
  console.log('  UPS Available:', sa.carriers.ups.available, '| Total NPR:', sa.carriers.ups.grandTotalNPR, `| Base AED: ${sa.carriers.ups.baseFreightAED}`);

  console.log('\nTesting Non-GCC Destination (Germany - 20kg):');
  const de = await test('DE', 20.0);
  console.log('  Aramex Available:', de.carriers.aramex.available, '| Reason:', de.carriers.aramex.reason);
  console.log('  UPS Available:', de.carriers.ups.available, '| Total NPR:', de.carriers.ups.grandTotalNPR, `| Base AED: ${de.carriers.ups.baseFreightAED}`);
}

run().catch(console.error);
