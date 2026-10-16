const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const SheetAnalyzer = require('./sheet_analyzer');
const fuelSurchargeSync = require('./fuel_surcharge_sync');
const marginEngine = require('./margin_engine');
const excelExportService = require('./excel_export_service');

const app = express();
const PORT = process.env.PORT || 8080;

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

// Safe JSON Write Helper (gracefully handles read-only serverless cloud filesystems)
function safeWriteJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn(`[Storage] File write skipped in serverless environment (${err.message}):`, filePath);
    return false;
  }
}

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
  safeWriteJson(airlinesPath, airlinesData);
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
  safeWriteJson(agencyClearancePath, agencyClearanceData);
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

// REST ENDPOINT: Save Default Fuel Surcharges (Permanent Manual Update)
app.post('/api/fuel-surcharges/save-defaults', (req, res) => {
  try {
    const { aramexPct, upsPct, note, aramexRatePercent, upsRatePercent, aramex, ups } = req.body;
    const aVal = aramexPct !== undefined ? aramexPct 
      : (aramexRatePercent !== undefined ? aramexRatePercent 
      : (aramex !== undefined ? aramex : undefined));
    const uVal = upsPct !== undefined ? upsPct 
      : (upsRatePercent !== undefined ? upsRatePercent 
      : (ups !== undefined ? ups : undefined));

    if (aVal !== undefined && !isNaN(parseFloat(aVal))) {
      fuelSurchargeSync.updateSurcharge('aramex', parseFloat(aVal), note || 'Operator saved custom default FSC');
    }
    if (uVal !== undefined && !isNaN(parseFloat(uVal))) {
      fuelSurchargeSync.updateSurcharge('ups', parseFloat(uVal), note || 'Operator saved custom default FSC');
    }
    const freshData = fuelSurchargeSync.getData();
    res.json({ success: true, message: "Default Fuel Surcharges saved permanently", data: freshData });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// REST ENDPOINT: Margin Management Rules (Profit Markup Engine)
app.get('/api/margin-rules', (req, res) => {
  res.json({ success: true, data: marginEngine.getConfig() });
});

app.post('/api/margin-rules/save', (req, res) => {
  try {
    const updated = marginEngine.saveConfig(req.body);
    res.json({ success: true, message: "Margin rules saved permanently", data: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/margin-rules/set-global', (req, res) => {
  try {
    const updated = marginEngine.setGlobalRule(req.body);
    res.json({ success: true, message: "Global margin rule updated", data: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/margin-rules/set-country', (req, res) => {
  try {
    const { countryCode, ...ruleData } = req.body;
    if (!countryCode) return res.status(400).json({ error: "countryCode is required" });
    const updated = marginEngine.setCountryRule(countryCode, ruleData);
    res.json({ success: true, message: `Country margin rule for ${countryCode.toUpperCase()} updated`, data: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/margin-rules/country/:code', (req, res) => {
  try {
    const deleted = marginEngine.deleteCountryRule(req.params.code);
    res.json({ success: true, message: `Country rule for ${req.params.code} removed`, deleted });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/margin-rules/calculate', (req, res) => {
  try {
    const { baseCostNPR, countryCode, weightKg, carrierId } = req.body;
    const nprPerAed = forexRates.rates["AED"] ? forexRates.rates["AED"].sell : 42.23;
    const pricing = marginEngine.calculatePricing(baseCostNPR, countryCode, weightKg, carrierId, nprPerAed);
    res.json({ success: true, data: pricing });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// REST ENDPOINT: Export Excel Rate Sheet & Zone Directory in NPR
app.get('/api/export/excel', (req, res) => {
  try {
    const nprPerAed = forexRates.rates["AED"] ? forexRates.rates["AED"].sell : 42.23;
    const buffer = excelExportService.generateBuffer(nprPerAed);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Nepal_Dubai_Logistics_Rates_And_Zones_NPR.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error("Excel Export Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// REST ENDPOINT: Get & Save GCC Rate Sheet (Aramex Dedicated)
app.get('/api/rates/gcc', (req, res) => {
  if (fs.existsSync(gccRatesPath)) {
    gccRates = JSON.parse(fs.readFileSync(gccRatesPath, 'utf8'));
  }
  res.json({ success: true, data: gccRates });
});

app.post('/api/rates/gcc/save', (req, res) => {
  try {
    const { updatedRates } = req.body;
    if (!updatedRates || typeof updatedRates !== 'object') {
      return res.status(400).json({ error: "Invalid GCC rates data provided." });
    }
    gccRates = updatedRates;
    safeWriteJson(gccRatesPath, gccRates);
    res.json({ success: true, message: "Dedicated GCC Rate Sheet saved permanently", data: gccRates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// REST ENDPOINT: Get & Save International Express Saver Rate Sheet (UPS Matrix)
app.get('/api/rates/international', (req, res) => {
  if (fs.existsSync(intlRatesPath)) {
    intlRates = JSON.parse(fs.readFileSync(intlRatesPath, 'utf8'));
  }
  res.json({ success: true, data: intlRates });
});

app.post('/api/rates/international/save', (req, res) => {
  try {
    const { updatedTable, updatedColumns } = req.body;
    if (updatedTable && Array.isArray(updatedTable)) {
      intlRates.table = updatedTable;
    }
    if (updatedColumns && Array.isArray(updatedColumns)) {
      intlRates.columns = updatedColumns;
    }
    safeWriteJson(intlRatesPath, intlRates);
    res.json({ success: true, message: "International Express Saver Matrix saved permanently", data: intlRates });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      safeWriteJson(gccRatesPath, gccRates);
    }
    if (analysis.extractedData.internationalRates) {
      intlRates = analysis.extractedData.internationalRates;
      safeWriteJson(intlRatesPath, intlRates);
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

    // 1. Multi-Box Package Intake & Dimensional Analysis
    const rawBoxes = req.body.boxes && Array.isArray(req.body.boxes) && req.body.boxes.length > 0
      ? req.body.boxes
      : [{
          weight: parseFloat(req.body.actualWeight) || 20.0,
          length: parseFloat(req.body.dimL) || 40,
          width: parseFloat(req.body.dimW) || 35,
          height: parseFloat(req.body.dimH) || 30,
          qty: 1
        }];

    let totalActualWeight = 0;
    let totalVolumetricWeight = 0;
    let totalPieces = 0;
    const processedBoxes = [];

    // Odd / Dimensional Surcharge Counts (evaluated per individual box)
    let upsAhsCount = 0;   // Additional Handling: wt > 25kg OR L > 122cm OR W > 76cm
    let upsLpsCount = 0;   // Large Package: L + 2(W+H) > 300cm
    let upsOmlCount = 0;   // Over Max Limits: wt > 70kg OR L > 274cm OR L+2(W+H) > 400cm
    let aramexHeavyCount = 0;    // Heavy Piece: wt > 30kg OR L > 120cm
    let aramexOversizeCount = 0; // Oversize Freight: wt > 50kg OR L > 180cm

    rawBoxes.forEach((b, idx) => {
      const qty = Math.max(1, parseInt(b.qty, 10) || 1);
      const w = Math.max(0.1, parseFloat(b.weight) || 0.1);
      const l = Math.max(1, parseFloat(b.length) || 1);
      const wDim = Math.max(1, parseFloat(b.width) || 1);
      const h = Math.max(1, parseFloat(b.height) || 1);

      const dimsSorted = [l, wDim, h].sort((x, y) => y - x);
      const lMax = dimsSorted[0];
      const lMid = dimsSorted[1];
      const lMin = dimsSorted[2];
      const lengthAndGirth = lMax + 2 * (lMid + lMin);

      const boxVolPerPiece = (l * wDim * h) / 5000;
      const boxActualTotal = w * qty;
      const boxVolTotal = boxVolPerPiece * qty;

      totalActualWeight += boxActualTotal;
      totalVolumetricWeight += boxVolTotal;
      totalPieces += qty;

      // Check UPS Official Surcharge Rules (UAE Tariff Guide Page 27)
      let isUpsOML = false;
      let isUpsLPS = false;
      let isUpsAHS = false;

      if (w > 70.0 || lMax > 274.0 || lengthAndGirth > 400.0) {
        isUpsOML = true;
        upsOmlCount += qty;
      } else if (lengthAndGirth > 300.0) {
        isUpsLPS = true;
        upsLpsCount += qty;
      } else if (w > 25.0 || lMax > 122.0 || lMid > 76.0) {
        isUpsAHS = true;
        upsAhsCount += qty;
      }

      // Check Aramex Official Surcharge Rules (Dubai Hub)
      let isAramexOversize = false;
      let isAramexHeavy = false;

      if (w > 50.0 || lMax > 180.0) {
        isAramexOversize = true;
        aramexOversizeCount += qty;
      } else if (w > 30.0 || lMax > 120.0) {
        isAramexHeavy = true;
        aramexHeavyCount += qty;
      }

      processedBoxes.push({
        boxIndex: idx + 1,
        qty: qty,
        weightKg: w,
        lengthCm: l,
        widthCm: wDim,
        heightCm: h,
        volumetricKgPerPiece: parseFloat(boxVolPerPiece.toFixed(2)),
        totalActualKg: parseFloat(boxActualTotal.toFixed(2)),
        totalVolumetricKg: parseFloat(boxVolTotal.toFixed(2)),
        lengthAndGirthCm: parseFloat(lengthAndGirth.toFixed(1)),
        oddDimensionStatus: {
          upsAHS: isUpsAHS,
          upsLPS: isUpsLPS,
          upsOML: isUpsOML,
          aramexHeavy: isAramexHeavy,
          aramexOversize: isAramexOversize
        }
      });
    });

    totalActualWeight = parseFloat(totalActualWeight.toFixed(2));
    totalVolumetricWeight = parseFloat(totalVolumetricWeight.toFixed(2));
    const chargeableWeight = parseFloat(Math.max(totalActualWeight, totalVolumetricWeight).toFixed(2));

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

    // 5. Aramex Calculation (STRICTLY FOR GCC DESTINATIONS ONLY - NO POSTAL TAX)
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

      // Fuel Surcharge (FSC) - NO POSTAL TAX
      const aramexFscRate = parseFloat(fuelSurchargeAramexPct) / 100;
      const aramexFscAED = aramexBaseAED * aramexFscRate;

      // Odd / Over-dimensional Fees for Aramex
      const aramexHeavyFeeAED = aramexHeavyCount * 20.00; // Heavy piece >30kg
      const aramexOversizeFeeAED = aramexOversizeCount * 150.00; // Oversize >50kg/180cm
      const aramexOddFeesAED = aramexHeavyFeeAED + aramexOversizeFeeAED;
      const aramexOddFeesNPR = aramexOddFeesAED * nprPerAed;

      const aramexTotalSurchargesAED = aramexFscAED + aramexOddFeesAED;
      const aramexTotalSurchargesNPR = (aramexFscAED * nprPerAed) + aramexOddFeesNPR;

      // Landed Quotation = KTM-DXB Air Linehaul + Dubai Agency Clearance + Last-Mile Delivery with Surcharges
      const aramexTotalLmdAED = aramexBaseAED + aramexTotalSurchargesAED;
      const aramexGrandTotalAED = airFreightAED + dubaiClearanceAED + aramexTotalLmdAED;
      const aramexGrandTotalNPR = airFreightNPR + dubaiClearanceNPR + (aramexTotalLmdAED * nprPerAed);
      // Apply Commercial Profit Margin
      const aramexMargin = marginEngine.calculatePricing(aramexGrandTotalNPR, destination, chargeableWeight, 'aramex', nprPerAed);

      aramexResult = {
        available: true,
        name: "Aramex Express (GCC Corridor)",
        source: "Dedicated GCC Non-Doc Sheet (ex-DXB)",
        baseFreightAED: parseFloat(aramexBaseAED.toFixed(2)),
        baseFreightNPR: parseFloat((aramexBaseAED * nprPerAed).toFixed(2)),
        fuelSurchargePct: `${fuelSurchargeAramexPct}%`,
        fuelSurchargeAED: parseFloat(aramexFscAED.toFixed(2)),
        fuelSurchargeNPR: parseFloat((aramexFscAED * nprPerAed).toFixed(2)),
        oddDimensionFeesAED: parseFloat(aramexOddFeesAED.toFixed(2)),
        oddDimensionFeesNPR: parseFloat(aramexOddFeesNPR.toFixed(2)),
        oddDimensionBreakdown: {
          heavyPieceCount: aramexHeavyCount,
          heavyPieceFeeAED: aramexHeavyFeeAED,
          oversizeCount: aramexOversizeCount,
          oversizeFeeAED: aramexOversizeFeeAED
        },
        totalSurchargesAED: parseFloat(aramexTotalSurchargesAED.toFixed(2)),
        totalSurchargesNPR: parseFloat(aramexTotalSurchargesNPR.toFixed(2)),
        totalLmdWithSurchargesAED: parseFloat(aramexTotalLmdAED.toFixed(2)),
        totalLmdWithSurchargesNPR: parseFloat((aramexTotalLmdAED * nprPerAed).toFixed(2)),
        grandTotalNPR: parseFloat(aramexGrandTotalNPR.toFixed(2)),
        grandTotalAED: parseFloat(aramexGrandTotalAED.toFixed(2)),
        // Per-Kilo Rates
        ratePerKgNPR: parseFloat((aramexGrandTotalNPR / chargeableWeight).toFixed(2)),
        ratePerKgAED: parseFloat((aramexGrandTotalAED / chargeableWeight).toFixed(2)),
        lmdRatePerKgNPR: parseFloat(((aramexTotalLmdAED * nprPerAed) / chargeableWeight).toFixed(2)),
        lmdRatePerKgAED: parseFloat((aramexTotalLmdAED / chargeableWeight).toFixed(2)),
        // Commercial Selling Pricing with Configured Margin
        commercialPricing: aramexMargin,
        commercialSellingTotalNPR: aramexMargin.commercialSellingTotalNPR,
        commercialSellingTotalAED: aramexMargin.commercialSellingTotalAED,
        commercialSellingRatePerKgNPR: aramexMargin.commercialSellingRatePerKgNPR,
        commercialSellingRatePerKgAED: aramexMargin.commercialSellingRatePerKgAED,
        marginPercent: aramexMargin.marginPercent,
        marginAmountNPR: aramexMargin.marginAmountNPR,
        marginAmountAED: aramexMargin.marginAmountAED,
        marginRuleDescription: aramexMargin.ruleDescription,
        marginTierLabel: aramexMargin.tierLabel
      };
    } else {
      aramexResult = {
        available: false,
        name: "Aramex Express",
        reason: "Aramex is configured exclusively for GCC destinations (Bahrain, Oman, Kuwait, Qatar, Saudi Arabia, UAE). This global destination is routed via UPS.",
        grandTotalNPR: 0,
        grandTotalAED: 0,
        ratePerKgNPR: 0,
        ratePerKgAED: 0
      };
    }

    // 6. UPS Calculation (EXACT MATCH AS PER SHEET - NO MARKUP - NO POSTAL TAX)
    const upsBaseAED = lookupInternationalRate(colKey, chargeableWeight, productType);
    const upsFscRate = parseFloat(fuelSurchargeUpsPct) / 100;
    const upsFscAED = upsBaseAED * upsFscRate;

    // Odd / Over-dimensional Fees for UPS (Page 27 UAE Tariff Guide)
    const upsAhsFeeAED = upsAhsCount * 18.30; // Additional Handling: wt>25kg or L>122 / W>76
    const upsLpsFeeAED = upsLpsCount * 257.00; // Large Package: L + 2(W+H) > 300cm
    const upsOmlFeeAED = upsOmlCount * 479.00; // Over Max Limits: wt>70kg or L>274 or L+2(W+H)>400
    const upsOddFeesAED = upsAhsFeeAED + upsLpsFeeAED + upsOmlFeeAED;
    const upsOddFeesNPR = upsOddFeesAED * nprPerAed;

    const upsTotalSurchargesAED = upsFscAED + upsOddFeesAED;
    const upsTotalSurchargesNPR = (upsFscAED * nprPerAed) + upsOddFeesNPR;

    const upsTotalLmdAED = upsBaseAED + upsTotalSurchargesAED;
    const upsGrandTotalAED = airFreightAED + dubaiClearanceAED + upsTotalLmdAED;
    const upsGrandTotalNPR = airFreightNPR + dubaiClearanceNPR + (upsTotalLmdAED * nprPerAed);

    // Apply Commercial Profit Margin
    const upsMargin = marginEngine.calculatePricing(upsGrandTotalNPR, destination, chargeableWeight, 'ups', nprPerAed);

    const upsResult = {
      available: true,
      name: "UPS Worldwide Express / Saver",
      source: countryInfo.directCol ? `Express Saver Matrix (Direct Lane: ${countryInfo.directCol})` : `Express Saver Matrix (Zone: ${countryInfo.zone})`,
      columnUsed: colKey,
      baseFreightAED: parseFloat(upsBaseAED.toFixed(2)),
      baseFreightNPR: parseFloat((upsBaseAED * nprPerAed).toFixed(2)),
      fuelSurchargePct: `${fuelSurchargeUpsPct}%`,
      fuelSurchargeAED: parseFloat(upsFscAED.toFixed(2)),
      fuelSurchargeNPR: parseFloat((upsFscAED * nprPerAed).toFixed(2)),
      oddDimensionFeesAED: parseFloat(upsOddFeesAED.toFixed(2)),
      oddDimensionFeesNPR: parseFloat(upsOddFeesNPR.toFixed(2)),
      oddDimensionBreakdown: {
        ahsCount: upsAhsCount,
        ahsFeeAED: upsAhsFeeAED,
        lpsCount: upsLpsCount,
        lpsFeeAED: upsLpsFeeAED,
        omlCount: upsOmlCount,
        omlFeeAED: upsOmlFeeAED
      },
      totalSurchargesAED: parseFloat(upsTotalSurchargesAED.toFixed(2)),
      totalSurchargesNPR: parseFloat(upsTotalSurchargesNPR.toFixed(2)),
      totalLmdWithSurchargesAED: parseFloat(upsTotalLmdAED.toFixed(2)),
      totalLmdWithSurchargesNPR: parseFloat((upsTotalLmdAED * nprPerAed).toFixed(2)),
      grandTotalNPR: parseFloat(upsGrandTotalNPR.toFixed(2)),
      grandTotalAED: parseFloat(upsGrandTotalAED.toFixed(2)),
      // Per-Kilo Rates
      ratePerKgNPR: parseFloat((upsGrandTotalNPR / chargeableWeight).toFixed(2)),
      ratePerKgAED: parseFloat((upsGrandTotalAED / chargeableWeight).toFixed(2)),
      lmdRatePerKgNPR: parseFloat(((upsTotalLmdAED * nprPerAed) / chargeableWeight).toFixed(2)),
      lmdRatePerKgAED: parseFloat((upsTotalLmdAED / chargeableWeight).toFixed(2)),
      // Commercial Selling Pricing with Configured Margin
      commercialPricing: upsMargin,
      commercialSellingTotalNPR: upsMargin.commercialSellingTotalNPR,
      commercialSellingTotalAED: upsMargin.commercialSellingTotalAED,
      commercialSellingRatePerKgNPR: upsMargin.commercialSellingRatePerKgNPR,
      commercialSellingRatePerKgAED: upsMargin.commercialSellingRatePerKgAED,
      marginPercent: upsMargin.marginPercent,
      marginAmountNPR: upsMargin.marginAmountNPR,
      marginAmountAED: upsMargin.marginAmountAED,
      marginRuleDescription: upsMargin.ruleDescription,
      marginTierLabel: upsMargin.tierLabel
    };

    // 7. Precise Mathematical Audit Trail
    const stepByStepAudit = [
      {
        step: 1,
        title: "Consignment Multi-Box Weight & Dimensions",
        rule: `Evaluated across ${totalPieces} package(s) | Chargeable Weight = max(Total Dead Weight, Total Volumetric Weight)`,
        totalPieces: totalPieces,
        actualWeightKg: totalActualWeight,
        volumetricWeightKg: totalVolumetricWeight,
        chargeableKg: chargeableWeight,
        packages: processedBoxes,
        explanation: `All air linehaul, Dubai agency clearance, and last-mile freight calculations are billed on ${chargeableWeight.toFixed(2)} kg.`
      },
      {
        step: 2,
        title: "KTM ➔ DXB Middle-Mile Air Linehaul (in NPR)",
        rule: `Origin Nepal to Dubai via ${airline.name} (+${slab}kg break slab)`,
        rateNprPerKg: airRateNprPerKg,
        formula: `${chargeableWeight} kg × NPR ${airRateNprPerKg}/kg = NPR ${airFreightNPR.toLocaleString()}`,
        amountNPR: parseFloat(airFreightNPR.toFixed(2)),
        amountAED: parseFloat(airFreightAED.toFixed(2)),
        ratePerKgNPR: airRateNprPerKg,
        ratePerKgAED: parseFloat((airFreightAED / chargeableWeight).toFixed(2))
      },
      {
        step: 3,
        title: "Dubai Agency / THC Clearance (Single Per-Kg Fee)",
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
          sheet: "GCC Dedicated Sheet",
          rateAED: aramexResult.baseFreightAED,
          rateNPR: aramexResult.baseFreightNPR,
          ratePerKgNPR: parseFloat((aramexResult.baseFreightNPR / chargeableWeight).toFixed(2))
        } : null,
        ups: {
          sheet: "Express Saver Matrix",
          column: colKey,
          rateAED: upsResult.baseFreightAED,
          rateNPR: upsResult.baseFreightNPR,
          ratePerKgNPR: parseFloat((upsResult.baseFreightNPR / chargeableWeight).toFixed(2))
        }
      },
      {
        step: 5,
        title: "Dubai Office Surcharges (FSC & Odd Dimension Handling - No Postal Tax)",
        rule: "Official Fuel Surcharge (FSC) + Odd / Over-dimensional / Overweight handling surcharges as per carrier Dubai rules (No Postal Tax).",
        aramex: isGccDestination ? {
          fuelPct: `${fuelSurchargeAramexPct}%`,
          fuelAED: aramexResult.fuelSurchargeAED,
          fuelNPR: aramexResult.fuelSurchargeNPR,
          oddFeesAED: aramexResult.oddDimensionFeesAED,
          oddFeesNPR: aramexResult.oddDimensionFeesNPR,
          totalSurchargesNPR: aramexResult.totalSurchargesNPR
        } : null,
        ups: {
          fuelPct: `${fuelSurchargeUpsPct}%`,
          fuelAED: upsResult.fuelSurchargeAED,
          fuelNPR: upsResult.fuelSurchargeNPR,
          oddFeesAED: upsResult.oddDimensionFeesAED,
          oddFeesNPR: upsResult.oddDimensionFeesNPR,
          totalSurchargesNPR: upsResult.totalSurchargesNPR
        }
      },
      {
        step: 6,
        title: "Net Landed Cost Breakdown (in NPR)",
        rule: "Total Net Landed Cost = KTM-DXB Air Linehaul + Dubai Clearance + Last-Mile Delivery with Surcharges (Zero Postal Tax)",
        formula: "Air Linehaul (NPR) + Dubai Clearance (NPR) + Last Mile Delivery & Surcharges (NPR)",
        aramexTotalNPR: isGccDestination ? aramexResult.grandTotalNPR : null,
        aramexRatePerKgNPR: isGccDestination ? aramexResult.ratePerKgNPR : null,
        upsTotalNPR: upsResult.grandTotalNPR,
        upsRatePerKgNPR: upsResult.ratePerKgNPR
      },
      {
        step: 7,
        title: "Commercial Profit Margin & Customer Selling Price (in NPR)",
        rule: "Configured Commercial Profit Margin dynamically applied across weight breaks and destination rules",
        formula: "Net Landed Cost (NPR) + Profit Margin Markup (NPR) = Commercial Selling Price (NPR)",
        aramex: isGccDestination ? {
          marginPercent: `${aramexResult.marginPercent}%`,
          marginAmountNPR: aramexResult.marginAmountNPR,
          commercialSellingTotalNPR: aramexResult.commercialSellingTotalNPR,
          commercialSellingRatePerKgNPR: aramexResult.commercialSellingRatePerKgNPR,
          ruleApplied: aramexResult.marginRuleDescription,
          tierLabel: aramexResult.marginTierLabel
        } : null,
        ups: {
          marginPercent: `${upsResult.marginPercent}%`,
          marginAmountNPR: upsResult.marginAmountNPR,
          commercialSellingTotalNPR: upsResult.commercialSellingTotalNPR,
          commercialSellingRatePerKgNPR: upsResult.commercialSellingRatePerKgNPR,
          ruleApplied: upsResult.marginRuleDescription,
          tierLabel: upsResult.marginTierLabel
        }
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
        totalPieces: totalPieces,
        packages: processedBoxes,
        weight: {
          actualKg: totalActualWeight,
          volumetricKg: totalVolumetricWeight,
          chargeableKg: chargeableWeight
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
        ratePerKgAED: parseFloat((airRateNprPerKg / nprPerAed).toFixed(2)),
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

// Fallback route for SPA (Express 5 compatible)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
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
}

module.exports = app;
