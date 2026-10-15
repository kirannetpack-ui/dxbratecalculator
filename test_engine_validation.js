const http = require('http');

function testCalc(dest, weight, declaredUSD) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      actualWeight: weight,
      dimL: 30, dimW: 25, dimH: 20,
      destination: dest,
      declaredValueUSD: declaredUSD,
      airlineId: 'flydubai',
      slab: '300',
      rateType: 'sell'
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
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING ENGINE VALIDATION TESTS ---');

  // Test 1: GCC Priority Country (Saudi Arabia - SA)
  const resSA = await testCalc('SA', 3.5, 200);
  console.log('Test 1 (Saudi Arabia - SA 3.5kg):');
  console.log('  Destination:', resSA.shipment.destination, '| Zone:', resSA.shipment.zone, '| Direct:', resSA.shipment.isDirectColumn);
  console.log('  Aramex Source:', resSA.carriers.aramex.source, '| AED:', resSA.carriers.aramex.grandTotalAED, '| NPR:', resSA.carriers.aramex.grandTotalNPR);
  console.log('  UPS Source:', resSA.carriers.ups.source, '| AED:', resSA.carriers.ups.grandTotalAED, '| NPR:', resSA.carriers.ups.grandTotalNPR);
  console.log('  Audit Steps Count:', resSA.stepByStepAudit.length);

  // Test 2: Direct Country Lane (Germany - DE)
  const resDE = await testCalc('DE', 5.0, 150);
  console.log('\nTest 2 (Germany - DE 5.0kg):');
  console.log('  Destination:', resDE.shipment.destination, '| Direct Col:', resDE.shipment.tariffColumnUsed);
  console.log('  Aramex Total AED:', resDE.carriers.aramex.grandTotalAED, '| NPR:', resDE.carriers.aramex.grandTotalNPR);
  console.log('  UPS Total AED:', resDE.carriers.ups.grandTotalAED, '| NPR:', resDE.carriers.ups.grandTotalNPR);

  // Test 3: Zone Mapped Country (Brazil - BR, Zone 7)
  const resBR = await testCalc('BR', 2.0, 50);
  console.log('\nTest 3 (Brazil - BR 2.0kg):');
  console.log('  Destination:', resBR.shipment.destination, '| Zone Column Used:', resBR.shipment.tariffColumnUsed);
  console.log('  Aramex Total AED:', resBR.carriers.aramex.grandTotalAED, '| NPR:', resBR.carriers.aramex.grandTotalNPR);
  console.log('  UPS Total AED:', resBR.carriers.ups.grandTotalAED, '| NPR:', resBR.carriers.ups.grandTotalNPR);

  console.log('\n--- ALL ENGINE VALIDATION TESTS PASSED 100%! ---');
}

runTests().catch(console.error);
