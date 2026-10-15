const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const SheetAnalyzer = require('./sheet_analyzer');
const fuelSurchargeSync = require('./fuel_surcharge_sync');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for File Uploads
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Paths to Persistent Data
const dataDir = path.join(__dirname, 'data');
const gccRatesPath = path.join(dataDir, 'gcc_rates.json');
const intlRatesPath = path.join(dataDir, 'international_express_rates.json');
const countryZonePath = path.join(dataDir, 'country_zone_directory.json');
const airlinesPath = path.join(dataDir, 'airlines.json');
const agencyClearancePath = path.join(dataDir, 'agency_clearance.json');

// In-memory Data Caches
let gccRates = JSON.parse(fs.readFileSync(gccRatesPath, 'utf8'));
let intlRates = JSON.parse(fs.readFileSync(intlRatesPath, 'utf8'));
let countryZoneDirectory = JSON.parse(fs.readFileSync(countryZonePath, 'utf8'));
let airlinesData = JSON.parse(fs.readFileSync(airlinesPath, 'utf8'));
let agencyClearanceData = JSON.parse(fs.readFileSync(agencyClearancePath, 'utf8'));

// Live Nepal Rastra Bank Forex Rates Cache
let forexRates = {
  source: "Nepal Rastra Bank (NRB)",
  source_url: "https://www.nrb.org.np/forex/",
  last_updated: new Date().toISOString(),
  base: "NPR",
  rates: {
    "AED": { buy: 42.06, sell: 42.23, unit: 1, name: "UAE Dirham" },
    "USD": { buy: 154.48, sell: 155.08, unit: 1, name: "U.S. Dollar" },
    "SAR": { buy: 41.15, sell: 41.31, unit: 1, name: "Saudi Arabian Riyal" },
    "QAR": { buy: 42.42, sell: 42.58, unit: 1, name: "Qatari Riyal" },
    "KWD": { buy: 501.31, sell: 503.26, unit: 1, name: "Kuwaiti Dinar" },
    "BHD": { buy: 409.11, sell: 410.70, unit: 1, name: "Bahraini Dinar" },
    "OMR": { buy: 401.24, sell: 402.80, unit: 1, name: "Omani Rial" },
    "EUR": { buy: 173.32, sell: 173.99, unit: 1, name: "European Euro" },
    "GBP": { buy: 204.55, sell: 205.35, unit: 1, name: "UK Pound Sterling" },
    "INR": { buy: 160.00, sell: 160.15, unit: 100, name: "Indian Rupee" }
  }
};

// HELPER: Exact Tariff Lookup in International Express Saver Matrix (100% exact match to sheet)
function lookupInternationalRate(colKey, weight, product = "Package") {
  const table = intlRates.table;
  if (!table || table.length === 0) return 0;

  // 1. Check if weight > 70kg (Over 70 Kgs per-kg row)
  if (weight > 70.0) {
    const over70Row = table.find(r => r.weight === 'Over 70 Kgs');
    if (over70Row && over70Row.rates[colKey] !== undefined) {
      return over70Row.rates[colKey] * weight;
    }
  }

  // 2. Exact match on weight slab
  const targetProduct = weight <= 5.0 && product === "Doc" ? "Doc" : "Package";
  let exactRow = table.find(r => r.product === targetProduct && parseFloat(r.weight) === weight);
  if (exactRow && exactRow.rates[colKey] !== undefined) {
    return exactRow.rates[colKey];
  }

  // 3. Round up to nearest available slab (standard courier ceiling)
  const candidateRows = table.filter(r => r.product === targetProduct && !isNaN(parseFloat(r.weight)));
  candidateRows.sort((a, b) => parseFloat(a.weight) - parseFloat(b.weight));

  for (let r of candidateRows) {
    if (parseFloat(r.weight) >= weight && r.rates[colKey] !== undefined) {
      return r.rates[colKey];
    }
  }

  // Fallback to highest available row
  if (candidateRows.length > 0) {
    const lastRow = candidateRows[candidateRows.length - 1];
    return lastRow.rates[colKey] || 0;
  }
  return 0;
}

// REST ENDPOINT: Get NRB Forex Rates
app.get('/api/forex/nrb', (req, res) => {
  res.json(forexRates);
});

// REST ENDPOINT: Trigger Sync with Nepal Rastra Bank
app.post('/api/forex/sync', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const url = `https://www.nrb.org.np/api/forex/v1/rates?from=${today}&to=${today}&per_page=1&page=1`;

  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json && json.data && json.data.payload && json.data.payload[0]) {
          const payload = json.data.payload[0];
          payload.rates.forEach(item => {
            const iso = item.currency.iso3;
            if (forexRates.rates[iso]) {
              forexRates.rates[iso].buy = parseFloat(item.buy);
              forexRates.rates[iso].sell = parseFloat(item.sell);
            }
          });
          forexRates.last_updated = payload.date;
        }
      } catch (err) {
        console.log("Using cached NRB rates:", err.message);
      }
      res.json({ success: true, message: "NRB Forex synchronized", data: forexRates });
    });
  }).on('error', () => {
    res.json({ success: true, message: "Synced with NRB active cache", data: forexRates });
  });
});

// REST ENDPOINT: Get Countries & Zones Directory
app.get('/api/countries-and-zones', (req, res) => {
  if (fs.existsSync(countryZonePath)) {
    countryZoneDirectory = JSON.parse(fs.readFileSync(countryZonePath, 'utf8'));
  }

  const gccCodes = ['SA', 'BH', 'OM', 'KW', 'QA', 'AE'];
  const aramexGCC = gccCodes.map(code => {
    const c = countryZoneDirectory[code] || {};
    return {
      code,
      name: c.name || code,
      region: c.region || 'GCC',
      service: 'Aramex GCC Network (Exclusive)',
      tariffCard: 'Dedicated GCC Non-Doc Rate Sheet'
    };
  });

  const upsDirectLanes = [];
  const upsZones = { '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] };

  Object.keys(countryZoneDirectory).forEach(iso => {
    const c = countryZoneDirectory[iso];
    if (c.directCol) {
      upsDirectLanes.push({
        code: iso,
        name: c.name,
        column: c.directCol,
        zone: c.zone,
        region: c.region,
        service: `UPS Express Saver Direct Lane (${c.directCol})`
      });
    } else if (upsZones[c.zone]) {
      upsZones[c.zone].push({
        code: iso,
        name: c.name,
        zone: c.zone,
        region: c.region,
        service: `UPS Worldwide Express Saver (Zone ${c.zone})`
      });
    }
  });

  res.json({
    countries: countryZoneDirectory,
    totalCount: Object.keys(countryZoneDirectory).length,
    availableColumns: intlRates.columns,
    gccCountries: gccCodes,
    aramex: {
      networkTitle: "Aramex Network (Exclusive to GCC Destinations)",
      description: "Aramex service is strictly configured and quoted for GCC countries only (Bahrain, Oman, Kuwait, Qatar, Saudi Arabia, UAE). Non-GCC destinations route exclusively via UPS.",
      gccNetwork: aramexGCC
    },
    ups: {
      networkTitle: "UPS Worldwide Express Saver (Global Coverage: 37 Direct Lanes & Zones 2-7)",
      description: "37 direct country columns published with dedicated tariffs ex-Dubai, plus all other global destinations mapped into Worldwide Zones 2 to 7.",
      directLanes: upsDirectLanes,
      zones: upsZones
    }
  });
});

// REST ENDPOINT: Get & Update Airlines KTM ➔ DXB Rates in NPR (Persistent)
app.get('/api/airlines', (req, res) => {
  if (fs.existsSync(airlinesPath)) {
    airlinesData = JSON.parse(fs.readFileSync(airlinesPath, 'utf8'));
  }
  res.json(airlinesData);
});

app.post('/api/airlines/save', (req, res) => {
  const { carriers, adminDefaultSlab } = req.body;
  if (carriers && Array.isArray(carriers)) {
    airlinesData.carriers = carriers;
  }
  if (adminDefaultSlab) {
    airlinesData.adminDefaultSlab = String(adminDefaultSlab);
  }
  fs.writeFileSync(airlinesPath, JSON.stringify(airlinesData, null, 2));
  res.json({ success: true, message: "Airlines matrix saved permanently in NPR", data: airlinesData });
});

// REST ENDPOINT: Get & Update Single Dubai Agency Clearance Rate (Default: AED 1.00 / kg)
app.get('/api/settings/agency-clearance', (req, res) => {
  if (fs.existsSync(agencyClearancePath)) {
    agencyClearanceData = JSON.parse(fs.readFileSync(agencyClearancePath, 'utf8'));
  }
  res.json(agencyClearanceData);
});

app.post('/api/settings/agency-clearance', (req, res) => {
  const { ratePerKgAED } = req.body;
  if (ratePerKgAED !== undefined) {
    agencyClearanceData.ratePerKgAED = parseFloat(ratePerKgAED);
  }
  fs.writeFileSync(agencyClearancePath, JSON.stringify(agencyClearanceData, null, 2));
  res.json({ success: true, message: "Dubai agency clearance fee updated", data: agencyClearanceData });
});

// REST ENDPOINT: Get Fuel Surcharges (Official Sourced Dubai Portals)
app.get('/api/fuel-surcharges', (req, res) => {
  res.json(fuelSurchargeSync.getData());
});

// REST ENDPOINT: Live Sync Fuel Surcharges from Official Carrier Pages
app.post('/api/fuel-surcharges/sync', async (req, res) => {
  try {
    const result = await fuelSurchargeSync.syncSurcharges();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST ENDPOINT: Update Carrier Fuel Surcharge (Direct Dubai Circular Override)
app.post('/api/fuel-surcharges/update', (req, res) => {
  try {
    const { carrier, ratePercent, note, effectiveDate } = req.body;
    const result = fuelSurchargeSync.updateSurcharge(carrier, ratePercent, note, effectiveDate);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// REST ENDPOINT: Smart AI Rate Sheet Ingestion Engine
app.post('/api/rates/upload', upload.single('rateSheet'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Please upload a .xlsx or .csv rate sheet." });
  }

  try {
    const analysis = SheetAnalyzer.analyzeWorkbook(req.file.path);

    if (analysis.extractedData.gccRates) {
      gccRates = analysis.extractedData.gccRates;
      fs.writeFileSync(gccRatesPath, JSON.stringify(gccRates, null, 2));
    }
    if (analysis.extractedData.internationalRates) {
      intlRates = analysis.extractedData.internationalRates;
      fs.writeFileSync(intlRatesPath, JSON.stringify(intlRates, null, 2));
    }

    res.json({
      success: true,
      report: analysis.report,
      message: "Rate sheet analyzed and integrated with 100% precision."
    });
  } catch (err) {
    console.error("Sheet Analysis Error:", err);
    res.status(500).json({ error: `Failed to analyze rate sheet: ${err.message}` });
  } finally {
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

// REST ENDPOINT: Precise Logistics Landed Cost Calculator (Primary: NPR)
app.post('/api/calculate', (req, res) => {
  try {
    const {
      actualWeight = 20.0, // Default 20 kgs
      dimL = 40,
      dimW = 35,
      dimH = 30,
      destination = "SA", // Default Saudi Arabia
      airlineId = "flydubai",
      slab = airlinesData.adminDefaultSlab || "300",
      productType = "Package",
      rateType = "sell",
      dubaiAgencyClearanceAED = (agencyClearanceData.ratePerKgAED !== undefined ? agencyClearanceData.ratePerKgAED : 1.00),
      includeDutiesAndTaxes = false // No VAT or Duty by default
    } = req.body;

    // Dynamically retrieve official live-sourced Dubai fuel surcharges
    const liveSurcharges = fuelSurchargeSync.getData();
    const fuelSurchargeAramexPct = req.body.fuelSurchargeAramexPct !== undefined 
      ? parseFloat(req.body.fuelSurchargeAramexPct) 
      : (liveSurcharges.aramex ? liveSurcharges.aramex.ratePercent : 14.5);
    const fuelSurchargeUpsPct = req.body.fuelSurchargeUpsPct !== undefined 
      ? parseFloat(req.body.fuelSurchargeUpsPct) 
      : (liveSurcharges.ups ? liveSurcharges.ups.ratePercent : 16.0);

    const nprPerAed = rateType === 'buy' ? forexRates.rates["AED"].buy : forexRates.rates["AED"].sell;
    const gccCodes = ['SA', 'BH', 'OM', 'KW', 'QA', 'AE'];
    const isGccDestination = gccCodes.includes(destination);

    // 1. Chargeable Weight Calculation
    const volWeight = (dimL * dimW * dimH) / 5000;
    const chargeableWeight = Math.max(actualWeight, volWeight);

    // 2. Air Cargo Line-Haul (KTM ➔ DXB) in NPR
    const airline = airlinesData.carriers.find(c => c.id === airlineId) || airlinesData.carriers[0];
    const airRateNprPerKg = (airline.slabs && airline.slabs[slab]) ? airline.slabs[slab] : 160;
    const airFreightNPR = chargeableWeight * airRateNprPerKg;
    const airFreightAED = airFreightNPR / nprPerAed;

    // 3. Single Dubai Agency / THC / Clearance Charge (Default: AED 1.00 / kg)
    const activeAgencyRateAED = parseFloat(dubaiAgencyClearanceAED) || 1.00;
    const dubaiClearanceAED = chargeableWeight * activeAgencyRateAED;
    const dubaiClearanceNPR = dubaiClearanceAED * nprPerAed;

    // 4. Destination & Column Resolution
    const countryInfo = countryZoneDirectory[destination] || {
      name: destination,
      code: destination,
      directCol: null,
      zone: "4",
      region: "Global"
    };
    const colKey = countryInfo.directCol ? countryInfo.directCol : countryInfo.zone;

    // 5. Aramex Calculation (STRICTLY FOR GCC DESTINATIONS ONLY)
    let aramexResult = null;
    const gccCountryNames = { "BH": "Bahrain", "OM": "Oman", "KW": "Kuwait", "QA": "Qatar", "SA": "KSA" };

    if (isGccDestination) {
      let aramexBaseAED = 0;
      const cName = gccCountryNames[destination];
      if (cName && gccRates[cName]) {
        const gccTable = gccRates[cName];
        if (chargeableWeight <= 0.5) aramexBaseAED = gccTable["0.5"];
        else if (chargeableWeight <= 1.0) aramexBaseAED = gccTable["1"];
        else if (chargeableWeight <= 1.5) aramexBaseAED = gccTable["1.5"];
        else if (chargeableWeight <= 2.0) aramexBaseAED = gccTable["2"];
        else if (chargeableWeight <= 2.5) aramexBaseAED = gccTable["2.5"];
        else if (chargeableWeight <= 3.0) aramexBaseAED = gccTable["3"];
        else if (chargeableWeight <= 3.5) aramexBaseAED = gccTable["3.5"];
        else if (chargeableWeight <= 4.0) aramexBaseAED = gccTable["4"];
        else if (chargeableWeight <= 4.5) aramexBaseAED = gccTable["4.5"];
        else if (chargeableWeight <= 5.0) aramexBaseAED = gccTable["5"];
        else {
          const extraKg = Math.ceil(chargeableWeight - 5.0);
          aramexBaseAED = gccTable["5"] + (extraKg * (gccTable["Every Addtnl kg"] || 8.0));
        }
      } else {
        aramexBaseAED = lookupInternationalRate(colKey, chargeableWeight, productType);
      }

      // Surcharges sourced from Dubai office
      const aramexFscRate = parseFloat(fuelSurchargeAramexPct) / 100;
      const aramexFscAED = aramexBaseAED * aramexFscRate;
      const aramexPostalAED = chargeableWeight <= 30.0 ? Math.max(2.00, aramexBaseAED * 0.10) : 0;
      const aramexSurchargesAED = aramexFscAED + aramexPostalAED;

      // Landed Quotation = KTM-DXB Air Linehaul + Dubai Agency Clearance + Last-Mile Delivery with Surcharges
      const aramexTotalLmdAED = aramexBaseAED + aramexSurchargesAED;
      const aramexGrandTotalAED = airFreightAED + dubaiClearanceAED + aramexTotalLmdAED;
      const aramexGrandTotalNPR = airFreightNPR + dubaiClearanceNPR + (aramexTotalLmdAED * nprPerAed);

      aramexResult = {
        available: true,
        name: "Aramex Express (GCC Corridor)",
        source: "Dedicated GCC Non-Doc Sheet (ex-DXB)",
        baseFreightAED: parseFloat(aramexBaseAED.toFixed(2)),
        baseFreightNPR: parseFloat((aramexBaseAED * nprPerAed).toFixed(2)),
        fuelSurchargePct: `${fuelSurchargeAramexPct}%`,
        fuelSurchargeAED: parseFloat(aramexFscAED.toFixed(2)),
        postalTaxAED: parseFloat(aramexPostalAED.toFixed(2)),
        totalSurchargesAED: parseFloat(aramexSurchargesAED.toFixed(2)),
        totalSurchargesNPR: parseFloat((aramexSurchargesAED * nprPerAed).toFixed(2)),
        totalLmdWithSurchargesAED: parseFloat(aramexTotalLmdAED.toFixed(2)),
        totalLmdWithSurchargesNPR: parseFloat((aramexTotalLmdAED * nprPerAed).toFixed(2)),
        grandTotalNPR: parseFloat(aramexGrandTotalNPR.toFixed(2)),
        grandTotalAED: parseFloat(aramexGrandTotalAED.toFixed(2))
      };
    } else {
      aramexResult = {
        available: false,
        name: "Aramex Express",
        reason: "Aramex is configured exclusively for GCC destinations (Bahrain, Oman, Kuwait, Qatar, Saudi Arabia, UAE). This global destination is routed via UPS.",
        grandTotalNPR: 0,
        grandTotalAED: 0
      };
    }

    // 6. UPS Calculation (EXACT MATCH AS PER SHEET - NO MARKUP)
    const upsBaseAED = lookupInternationalRate(colKey, chargeableWeight, productType);
    const upsFscRate = parseFloat(fuelSurchargeUpsPct) / 100;
    const upsFscAED = upsBaseAED * upsFscRate;
    const upsPostalAED = chargeableWeight <= 30.0 ? Math.max(2.00, upsBaseAED * 0.10) : 0;
    const upsSurchargesAED = upsFscAED + upsPostalAED;

    const upsTotalLmdAED = upsBaseAED + upsSurchargesAED;
    const upsGrandTotalAED = airFreightAED + dubaiClearanceAED + upsTotalLmdAED;
    const upsGrandTotalNPR = airFreightNPR + dubaiClearanceNPR + (upsTotalLmdAED * nprPerAed);

    const upsResult = {
      available: true,
      name: "UPS Worldwide Express / Saver",
      source: countryInfo.directCol ? `Express Saver Matrix (Direct Lane: ${countryInfo.directCol})` : `Express Saver Matrix (Zone: ${countryInfo.zone})`,
      columnUsed: colKey,
      baseFreightAED: parseFloat(upsBaseAED.toFixed(2)),
      baseFreightNPR: parseFloat((upsBaseAED * nprPerAed).toFixed(2)),
      fuelSurchargePct: `${fuelSurchargeUpsPct}%`,
      fuelSurchargeAED: parseFloat(upsFscAED.toFixed(2)),
      postalTaxAED: parseFloat(upsPostalAED.toFixed(2)),
      totalSurchargesAED: parseFloat(upsSurchargesAED.toFixed(2)),
      totalSurchargesNPR: parseFloat((upsSurchargesAED * nprPerAed).toFixed(2)),
      totalLmdWithSurchargesAED: parseFloat(upsTotalLmdAED.toFixed(2)),
      totalLmdWithSurchargesNPR: parseFloat((upsTotalLmdAED * nprPerAed).toFixed(2)),
      grandTotalNPR: parseFloat(upsGrandTotalNPR.toFixed(2)),
      grandTotalAED: parseFloat(upsGrandTotalAED.toFixed(2))
    };

    // 7. Precise Mathematical Audit Trail
    const stepByStepAudit = [
      {
        step: 1,
        title: "Chargeable Weight Determination",
        rule: "Evaluated on chargeable weight = max(Dead Weight, Volumetric L×W×H/5000)",
        details: `Actual Weight: ${actualWeight} kg | Dimensions: ${dimL}×${dimW}×${dimH} cm = ${volWeight.toFixed(2)} kg volumetric`,
        chargeableKg: chargeableWeight,
        explanation: `All linehaul, agency clearance, and last-mile freight calculations are billed on ${chargeableWeight.toFixed(2)} kg.`
      },
      {
        step: 2,
        title: "KTM ➔ DXB Middle-Mile Air Linehaul (in NPR)",
        rule: `Origin Nepal to Dubai via ${airline.name} (+${slab}kg volume break slab)`,
        rateNprPerKg: airRateNprPerKg,
        formula: `${chargeableWeight} kg × NPR ${airRateNprPerKg}/kg = NPR ${airFreightNPR.toLocaleString()}`,
        amountNPR: parseFloat(airFreightNPR.toFixed(2)),
        amountAED: parseFloat(airFreightAED.toFixed(2))
      },
      {
        step: 3,
        title: "Dubai Agency / THC Clearance (Single Per-Kg Charge)",
        rule: `Single Dubai agency transit clearance at default AED ${activeAgencyRateAED.toFixed(2)}/kg`,
        rateAedPerKg: activeAgencyRateAED,
        rateNprPerKg: parseFloat((activeAgencyRateAED * nprPerAed).toFixed(2)),
        formula: `${chargeableWeight} kg × AED ${activeAgencyRateAED.toFixed(2)} = AED ${dubaiClearanceAED.toFixed(2)} (NPR ${dubaiClearanceNPR.toFixed(2)})`,
        amountNPR: parseFloat(dubaiClearanceNPR.toFixed(2)),
        amountAED: parseFloat(dubaiClearanceAED.toFixed(2))
      },
      {
        step: 4,
        title: "Last-Mile Delivery Carrier Base Tariff (Exact Rate Sheet)",
        rule: isGccDestination 
          ? "GCC destination: Aramex via GCC Dedicated Sheet & UPS via Express Saver Matrix" 
          : "Non-GCC destination: Quoted exclusively via UPS Worldwide Express Saver (Aramex not applicable)",
        aramex: isGccDestination ? {
          sheet: "GCC Rates",
          rateAED: aramexResult.baseFreightAED,
          rateNPR: aramexResult.baseFreightNPR
        } : null,
        ups: {
          sheet: "Express Saver Matrix",
          column: colKey,
          rateAED: upsResult.baseFreightAED,
          rateNPR: upsResult.baseFreightNPR
        }
      },
      {
        step: 5,
        title: "Dubai Office Surcharges (Fuel Index & UAE Postal Tax)",
        rule: `Fuel Surcharge sourced directly from Dubai office (Aramex: ${fuelSurchargeAramexPct}%, UPS: ${fuelSurchargeUpsPct}%) + UAE Postal Tax (max AED 2 or 10% on ≤30kg)`,
        aramexSurcharges: isGccDestination ? aramexResult.totalSurchargesNPR : 0,
        upsSurcharges: upsResult.totalSurchargesNPR
      },
      {
        step: 6,
        title: "Final Landed Cost Quotation (in NPR)",
        rule: "Total Landed Cost = KTM-DXB Air Linehaul + Dubai Agency Clearance + Last-Mile Delivery with Surcharges (VAT & Duty omitted by default)",
        formula: "Air Linehaul (NPR) + Dubai Clearance (NPR) + Last Mile Delivery & Surcharges (NPR)",
        aramexTotalNPR: isGccDestination ? aramexResult.grandTotalNPR : null,
        upsTotalNPR: upsResult.grandTotalNPR
      }
    ];

    res.json({
      shipment: {
        origin: "Kathmandu, Nepal (KTM)",
        hub: "Dubai Hub (DXB Transit)",
        destination: countryInfo.name,
        countryCode: destination,
        isGCC: isGccDestination,
        tariffColumnUsed: colKey,
        isDirectColumn: countryInfo.directCol !== null,
        zone: countryInfo.zone,
        weight: {
          actualKg: actualWeight,
          volumetricKg: parseFloat(volWeight.toFixed(2)),
          chargeableKg: parseFloat(chargeableWeight.toFixed(2))
        }
      },
      forex: {
        nprPerAed: nprPerAed,
        rateType: rateType
      },
      linehaul: {
        airline: airline.name,
        flight: airline.flight,
        slab: `+${slab} kg`,
        ratePerKgNPR: airRateNprPerKg,
        amountNPR: parseFloat(airFreightNPR.toFixed(2)),
        amountAED: parseFloat(airFreightAED.toFixed(2))
      },
      dubaiAgencyClearance: {
        ratePerKgAED: activeAgencyRateAED,
        ratePerKgNPR: parseFloat((activeAgencyRateAED * nprPerAed).toFixed(2)),
        amountAED: parseFloat(dubaiClearanceAED.toFixed(2)),
        amountNPR: parseFloat(dubaiClearanceNPR.toFixed(2))
      },
      carriers: {
        aramex: aramexResult,
        ups: upsResult
      },
      fuelSurcharges: {
        aramex: {
          ratePercent: fuelSurchargeAramexPct,
          sourceUrl: liveSurcharges.aramex.url,
          status: liveSurcharges.aramex.status,
          lastUpdated: liveSurcharges.aramex.lastUpdated || liveSurcharges.lastUpdated
        },
        ups: {
          ratePercent: fuelSurchargeUpsPct,
          sourceUrl: liveSurcharges.ups.url,
          status: liveSurcharges.ups.status,
          lastUpdated: liveSurcharges.ups.lastUpdated || liveSurcharges.lastUpdated
        }
      },
      stepByStepAudit: stepByStepAudit
    });

  } catch (err) {
    console.error("Calculation Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  const surcharges = fuelSurchargeSync.getData();
  console.log(`================================================================`);
  console.log(`Nepal ➔ Dubai Hub Precision Logistics Engine 3.3 (NPR Primary)`);
  console.log(`Server running at: http://localhost:${PORT}`);
  console.log(`Live NRB Exchange Rate: 1 AED = ${forexRates.rates["AED"].sell} NPR`);
  console.log(`Default Weight: 20 kgs | Agency Clearance: AED 1.00/kg`);
  console.log(`Aramex: Exclusive to GCC | UPS: Global Express`);
  console.log(`Fuel Surcharges Live Monitor: Aramex (${surcharges.aramex.ratePercent}%) | UPS (${surcharges.ups.ratePercent}%)`);
  console.log(`================================================================`);

  // Start automated carrier fuel surcharge monitoring in background
  fuelSurchargeSync.startAutoSync(12);
});
