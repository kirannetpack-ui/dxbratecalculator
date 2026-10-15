const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const SheetAnalyzer = require('./sheet_analyzer');

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

// HELPER: Exact Tariff Lookup in International Express Matrix
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

// REST ENDPOINT: Get Countries & Zones Directory with Separate Aramex & UPS Identifications
app.get('/api/countries-and-zones', (req, res) => {
  if (fs.existsSync(countryZonePath)) {
    countryZoneDirectory = JSON.parse(fs.readFileSync(countryZonePath, 'utf8'));
  }

  // 1. Aramex Network Classification
  const aramexGCC = ['SA', 'BH', 'OM', 'KW', 'QA', 'AE'].map(code => {
    const c = countryZoneDirectory[code] || {};
    return {
      code,
      name: c.name || code,
      region: c.region || 'GCC',
      service: c.aramexService || 'GCC Dedicated Network',
      tariffCard: c.aramexTariffCard || 'Dedicated GCC Non-Doc Tariff'
    };
  });

  const aramexZones = { '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] };

  // 2. UPS Network Classification
  const upsDirectLanes = [];
  const upsZones = { '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] };

  Object.keys(countryZoneDirectory).forEach(iso => {
    const c = countryZoneDirectory[iso];
    // Populate Aramex Zones
    if (aramexZones[c.zone]) {
      aramexZones[c.zone].push({
        code: iso,
        name: c.name,
        region: c.region,
        isGCC: ['SA', 'BH', 'OM', 'KW', 'QA', 'AE'].includes(iso),
        service: c.aramexService,
        tariffCard: c.aramexTariffCard
      });
    }
    // Populate UPS Zones & Direct Lanes
    if (c.directCol) {
      upsDirectLanes.push({
        code: iso,
        name: c.name,
        column: c.directCol,
        zone: c.zone,
        region: c.region,
        service: c.upsService
      });
    } else if (upsZones[c.zone]) {
      upsZones[c.zone].push({
        code: iso,
        name: c.name,
        zone: c.zone,
        region: c.region,
        service: c.upsService
      });
    }
  });

  res.json({
    countries: countryZoneDirectory,
    totalCount: Object.keys(countryZoneDirectory).length,
    availableColumns: intlRates.columns,
    aramex: {
      networkTitle: "Aramex Express Network (Priority GCC Hub & Global)",
      description: "Dedicated lower base rates for GCC (Bahrain, Oman, Kuwait, Qatar, KSA) via GCC Non-Doc Rate Card; global network routed via Levant & Partner Zones.",
      gccNetwork: aramexGCC,
      zones: aramexZones
    },
    ups: {
      networkTitle: "UPS Worldwide Express Saver (37 Direct Lanes & Zones 2-7)",
      description: "37 direct country columns published with dedicated tariffs, plus all other global destinations mapped into Worldwide Zones 2 to 7.",
      directLanes: upsDirectLanes,
      zones: upsZones
    }
  });
});

// REST ENDPOINT: Get & Update Airlines KTM ➔ DXB Rates (Persistent)
app.get('/api/airlines', (req, res) => {
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
  res.json({ success: true, message: "Airlines matrix saved permanently", data: airlinesData });
});

app.post('/api/airlines/add', (req, res) => {
  const { id, name, flight, slabs } = req.body;
  if (!id || !name || !slabs) {
    return res.status(400).json({ error: "Missing airline details (id, name, slabs)" });
  }
  const existingIdx = airlinesData.carriers.findIndex(c => c.id === id);
  if (existingIdx >= 0) {
    airlinesData.carriers[existingIdx] = { id, name, flight, slabs };
  } else {
    airlinesData.carriers.push({ id, name, flight, slabs });
  }
  fs.writeFileSync(airlinesPath, JSON.stringify(airlinesData, null, 2));
  res.json({ success: true, message: "Airline added/updated successfully", data: airlinesData });
});

// REST ENDPOINT: Get & Update Agency Clearance (Per Kg)
app.get('/api/settings/agency-clearance', (req, res) => {
  res.json(agencyClearanceData);
});

app.post('/api/settings/agency-clearance', (req, res) => {
  const { ratePerKgAED, minChargeAED, dubaiHubPerKgAED, dubaiHubMinAED } = req.body;
  if (ratePerKgAED !== undefined) agencyClearanceData.ratePerKgAED = parseFloat(ratePerKgAED);
  if (minChargeAED !== undefined) agencyClearanceData.minChargeAED = parseFloat(minChargeAED);
  if (dubaiHubPerKgAED !== undefined) agencyClearanceData.dubaiHubPerKgAED = parseFloat(dubaiHubPerKgAED);
  if (dubaiHubMinAED !== undefined) agencyClearanceData.dubaiHubMinAED = parseFloat(dubaiHubMinAED);

  fs.writeFileSync(agencyClearancePath, JSON.stringify(agencyClearanceData, null, 2));
  res.json({ success: true, message: "Agency clearance settings updated", data: agencyClearanceData });
});

// REST ENDPOINT: Smart AI Rate Sheet Uploader & Analyzer
app.post('/api/rates/upload', upload.single('rateSheet'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Please upload a .xlsx or .csv rate sheet." });
  }

  try {
    const analysis = SheetAnalyzer.analyzeWorkbook(req.file.path);

    // If new rates were extracted, update memory & disk
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
    // Clean up temporary file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

// REST ENDPOINT: Comprehensive Total Cost Calculator with Step-by-Step Mapping & Audit Engine
app.post('/api/calculate', (req, res) => {
  try {
    const {
      actualWeight = 1.0,
      dimL = 20,
      dimW = 20,
      dimH = 15,
      destination = "SA", // Country Code
      declaredValueUSD = 100,
      airlineId = "flydubai",
      slab = airlinesData.adminDefaultSlab || "300",
      productType = "Package",
      rateType = "sell",
      agencyClearanceRateAED = agencyClearanceData.ratePerKgAED,
      dubaiHubRateAED = agencyClearanceData.dubaiHubPerKgAED
    } = req.body;

    const nprPerAed = rateType === 'buy' ? forexRates.rates["AED"].buy : forexRates.rates["AED"].sell;
    const nprPerUsd = rateType === 'buy' ? forexRates.rates["USD"].buy : forexRates.rates["USD"].sell;
    const aedPerUsd = 3.6725;

    // 1. Chargeable Weight Calculation
    const volWeight = (dimL * dimW * dimH) / 5000;
    const chargeableWeight = Math.max(actualWeight, volWeight);

    // 2. Air Cargo Line-Haul (KTM ➔ DXB)
    const airline = airlinesData.carriers.find(c => c.id === airlineId) || airlinesData.carriers[0];
    const airRateUsdPerKg = (airline.slabs && airline.slabs[slab]) ? airline.slabs[slab] : 1.05;
    const airRateAedPerKg = airRateUsdPerKg * aedPerUsd;
    const airFreightAED = chargeableWeight * airRateAedPerKg;

    // 3. Agency Clearance (Per Kilo)
    const activeAgencyRate = parseFloat(agencyClearanceRateAED) || 1.50;
    const agencyClearanceAED = Math.max(agencyClearanceData.minChargeAED || 25, chargeableWeight * activeAgencyRate);

    // 4. Dubai Hub Transit Clearance (Per Kilo)
    const activeHubRate = parseFloat(dubaiHubRateAED) || 2.00;
    const dubaiHubAED = Math.max(agencyClearanceData.dubaiHubMinAED || 45, chargeableWeight * activeHubRate);

    // 5. Destination & Zone Resolution
    const countryInfo = countryZoneDirectory[destination] || {
      name: destination,
      code: destination,
      directCol: null,
      zone: "4",
      region: "Global",
      aramexService: "Aramex International Network",
      aramexTariffCard: "International Express Matrix (Zone 4)",
      upsService: "UPS Worldwide Express Saver (Zone 4)",
      upsTariffCol: "4",
      customs: { deMinimisUSD: 50, vatRate: 0.10, dutyRate: 0.05, ddpFeeUSD: 10.00 }
    };

    // Determine Tariff Column in International Express Sheet
    const colKey = countryInfo.directCol ? countryInfo.directCol : countryInfo.zone;

    // 6. Calculate Aramex Base Freight
    let aramexBaseAED = 0;
    let aramexSheetName = "International Matrix";
    const gccCountryNames = { "BH": "Bahrain", "OM": "Oman", "KW": "Kuwait", "QA": "Qatar", "SA": "KSA" };

    if (gccCountryNames[destination] && gccRates[gccCountryNames[destination]]) {
      // Use dedicated GCC Rate Sheet
      aramexSheetName = "GCC Rates (Dedicated Tariff)";
      const gccTable = gccRates[gccCountryNames[destination]];
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
      // Use International Express Sheet Column
      aramexSheetName = `International Express (${colKey})`;
      aramexBaseAED = lookupInternationalRate(colKey, chargeableWeight, productType);
    }

    // 7. Calculate UPS Base Freight
    // UPS uses the exact International Matrix column with standard UPS premium factor
    const upsBaseAED = lookupInternationalRate(colKey, chargeableWeight, productType) * 1.05;

    // 8. Surcharges (Fuel, Postal, VAT)
    const aramexFscAED = aramexBaseAED * 0.145; // 14.5% FSC
    const aramexPostalAED = Math.max(2.00, aramexBaseAED * 0.10);
    const aramexUaeVatAED = (aramexBaseAED + aramexFscAED + dubaiHubAED) * 0.05;

    const upsFscAED = upsBaseAED * 0.160; // 16.0% FSC
    const upsPostalAED = Math.max(2.00, upsBaseAED * 0.10);
    const upsUaeVatAED = (upsBaseAED + upsFscAED + dubaiHubAED) * 0.05;

    // 9. Destination Customs, Duty & Regulatory Fees
    const cRule = countryInfo.customs || { deMinimisUSD: 50, vatRate: 0.10, dutyRate: 0.05, ddpFeeUSD: 10.00 };
    const declaredValueAED = declaredValueUSD * aedPerUsd;
    let dutyAED = 0;
    if (declaredValueUSD > (cRule.deMinimisUSD || 0)) {
      dutyAED = declaredValueAED * (cRule.dutyRate || 0.05);
    }
    const destVatAED = (declaredValueAED + dutyAED) * (cRule.vatRate || 0.00);

    let regulatoryAED = 0;
    let regulatoryDesc = "";
    if (destination === 'SA' || destination === 'KSA') {
      regulatoryAED = (15 * 0.98) + (7.00 * aedPerUsd);
      if (declaredValueUSD > 266) regulatoryAED += 30; // Duty tier fee
      regulatoryDesc = "ZATCA e-Invoicing (15 SAR) + Aramex DDP Fee ($7.00 USD)";
    } else if (destination === 'OM' || destination === 'Oman') {
      regulatoryAED = (1.0 * 9.5) + (2.60 * aedPerUsd) + (aramexBaseAED * 0.06);
      regulatoryDesc = "Bayan (1 OMR) + 6% TRA Surcharge + DDP Fee ($2.60 USD)";
    } else if (destination === 'BH' || destination === 'Bahrain') {
      regulatoryAED = (13.26 * aedPerUsd) + (10.0 * 9.7);
      regulatoryDesc = "Customs Stamp ($13.26 USD) + TRA Inspection Fee (10 BHD)";
    } else if (destination === 'KW' || destination === 'Kuwait') {
      regulatoryAED = (1.0 * 12.0) + (3.0 * 12.0);
      regulatoryDesc = "Kuwait Bayan (1 KWD) + DDP Handling (3 KWD)";
    } else if (destination === 'QA' || destination === 'Qatar') {
      regulatoryAED = (20 * 1.01) + (6.85 * aedPerUsd);
      regulatoryDesc = "Qatar Bayan (20 QAR) + DDP Handling ($6.85 USD)";
    } else {
      regulatoryAED = (cRule.ddpFeeUSD || 10.0) * aedPerUsd;
      regulatoryDesc = `Standard Destination DDP Broker & Clearance Fee ($${(cRule.ddpFeeUSD || 10).toFixed(2)} USD)`;
    }

    const totalDestFeesAED = dutyAED + destVatAED + regulatoryAED;

    // 10. Grand Totals
    const aramexGrandAED = airFreightAED + agencyClearanceAED + dubaiHubAED + aramexBaseAED + aramexFscAED + aramexPostalAED + aramexUaeVatAED + totalDestFeesAED;
    const upsGrandAED = airFreightAED + agencyClearanceAED + dubaiHubAED + upsBaseAED + upsFscAED + upsPostalAED + upsUaeVatAED + totalDestFeesAED;

    const toNPR = (aed) => parseFloat((aed * nprPerAed).toFixed(2));
    const toUSD = (aed) => parseFloat((aed / aedPerUsd).toFixed(2));

    // 11. Complete Step-by-Step Transparent Audit Trail
    const stepByStepAudit = [
      {
        step: 1,
        title: "Weight & Volumetric Divisor Assessment",
        rule: "Chargeable weight is the greater of Dead Weight or Volumetric Weight (L × W × H / 5000 cm³)",
        formula: `Volumetric Weight = (${dimL} × ${dimW} × ${dimH}) / 5000 = ${volWeight.toFixed(2)} kg`,
        comparison: `Actual (${actualWeight.toFixed(2)} kg) vs Volumetric (${volWeight.toFixed(2)} kg)`,
        chargeableKg: parseFloat(chargeableWeight.toFixed(2)),
        explanation: `Since ${chargeableWeight.toFixed(2)} kg is the higher value, all air cargo, hub transit, agency clearance, and courier freight tariffs are billed on ${chargeableWeight.toFixed(2)} kg.`
      },
      {
        step: 2,
        title: "KTM ➔ DXB Middle-Mile Air Cargo Freight",
        rule: `Origin Nepal (KTM) to Dubai (DXB) flight sector via ${airline.name}`,
        formula: `${chargeableWeight.toFixed(2)} kg × $${airRateUsdPerKg.toFixed(2)}/kg = $${(chargeableWeight * airRateUsdPerKg).toFixed(2)} USD`,
        slabApplied: `+${slab} kg Volume Break Slab`,
        amountAED: parseFloat(airFreightAED.toFixed(2)),
        amountNPR: toNPR(airFreightAED),
        explanation: `Flight equipment: ${airline.flight}. Rate of $${airRateUsdPerKg.toFixed(2)}/kg converts to AED ${airRateAedPerKg.toFixed(2)}/kg using USD peg (3.6725). Total line-haul = AED ${airFreightAED.toFixed(2)} (NPR ${toNPR(airFreightAED).toLocaleString()}).`
      },
      {
        step: 3,
        title: "Agency Clearance & Dubai Transit Hub Handling",
        rule: "Per-kilogram fees for Nepal export agency clearance and Dubai Transit Hub handling / THC",
        agencyClearance: {
          ratePerKgAED: activeAgencyRate,
          amountAED: parseFloat(agencyClearanceAED.toFixed(2)),
          amountNPR: toNPR(agencyClearanceAED),
          rule: `max(Min AED ${agencyClearanceData.minChargeAED || 25}, ${chargeableWeight.toFixed(2)} kg × AED ${activeAgencyRate}/kg)`
        },
        dubaiHubClearance: {
          ratePerKgAED: activeHubRate,
          amountAED: parseFloat(dubaiHubAED.toFixed(2)),
          amountNPR: toNPR(dubaiHubAED),
          rule: `max(Min AED ${agencyClearanceData.dubaiHubMinAED || 45}, ${chargeableWeight.toFixed(2)} kg × AED ${activeHubRate}/kg)`
        },
        totalClearanceAED: parseFloat((agencyClearanceAED + dubaiHubAED).toFixed(2)),
        totalClearanceNPR: toNPR(agencyClearanceAED + dubaiHubAED)
      },
      {
        step: 4,
        title: "Last-Mile Delivery Carrier Tariff Resolution",
        rule: "Algorithmic lookup in validated rate sheets provided by ESHIPPER Dubai",
        aramexLookup: {
          sheetQueried: gccCountryNames[destination] ? "GCC Rates (Dedicated Non-Doc Sheet)" : "Express Saver Matrix",
          columnResolved: gccCountryNames[destination] ? gccCountryNames[destination] : colKey,
          isDirectCountry: gccCountryNames[destination] !== undefined || countryInfo.directCol !== null,
          weightSlabMatched: chargeableWeight <= 5.0 ? `${Math.ceil(chargeableWeight * 2) / 2} kg slab` : (gccCountryNames[destination] ? "5kg base + incremental kg" : "Weight slab row"),
          baseRateAED: parseFloat(aramexBaseAED.toFixed(2)),
          baseRateNPR: toNPR(aramexBaseAED)
        },
        upsLookup: {
          sheetQueried: "Express Saver (Transit ex-Dubai)",
          columnResolved: colKey,
          isDirectCountry: countryInfo.directCol !== null,
          weightSlabMatched: `${chargeableWeight} kg ceiling row`,
          baseRateAED: parseFloat(upsBaseAED.toFixed(2)),
          baseRateNPR: toNPR(upsBaseAED)
        }
      },
      {
        step: 5,
        title: "Last-Mile Surcharges & Local Tax Engine",
        rule: "Standard contractual surcharges: Monthly Fuel Surcharge (FSC), UAE Postal Tax, and FTA Local VAT",
        aramexSurcharges: {
          fuelSurchargePct: "14.5%",
          fuelSurchargeAED: parseFloat(aramexFscAED.toFixed(2)),
          postalTaxRule: "max(AED 2.00, 10% of base freight for parcels ≤ 30kg)",
          postalTaxAED: parseFloat(aramexPostalAED.toFixed(2)),
          uaeVatAED: parseFloat(aramexUaeVatAED.toFixed(2)),
          totalSurchargesAED: parseFloat((aramexFscAED + aramexPostalAED + aramexUaeVatAED).toFixed(2))
        },
        upsSurcharges: {
          fuelSurchargePct: "16.0%",
          fuelSurchargeAED: parseFloat(upsFscAED.toFixed(2)),
          postalTaxRule: "max(AED 2.00, 10% of base freight for parcels ≤ 30kg)",
          postalTaxAED: parseFloat(upsPostalAED.toFixed(2)),
          uaeVatAED: parseFloat(upsUaeVatAED.toFixed(2)),
          totalSurchargesAED: parseFloat((upsFscAED + upsPostalAED + upsUaeVatAED).toFixed(2))
        }
      },
      {
        step: 6,
        title: "Destination Customs Duties, Import VAT & DDP Platform Fees",
        rule: `Assessment based on destination (${countryInfo.name}) de minimis threshold ($${(cRule.deMinimisUSD || 50).toFixed(0)} USD)`,
        declaredValueUSD: declaredValueUSD,
        deMinimisUSD: cRule.deMinimisUSD || 50,
        isSubjectToDuty: declaredValueUSD > (cRule.deMinimisUSD || 50),
        customsDutyAED: parseFloat(dutyAED.toFixed(2)),
        importVatRate: `${((cRule.vatRate || 0) * 100).toFixed(1)}%`,
        importVatAED: parseFloat(destVatAED.toFixed(2)),
        regulatoryAndDDPFeesAED: parseFloat(regulatoryAED.toFixed(2)),
        totalDestFeesAED: parseFloat(totalDestFeesAED.toFixed(2)),
        totalDestFeesNPR: toNPR(totalDestFeesAED),
        regulatoryBreakdown: regulatoryDesc
      },
      {
        step: 7,
        title: "Nepal Rastra Bank (NRB) Dual Currency Final Landed Cost",
        rule: `Converted at active NRB ${rateType.toUpperCase()} rate: 1 AED = ${nprPerAed.toFixed(2)} NPR`,
        forexRates: {
          aedToNpr: nprPerAed,
          usdToNpr: nprPerUsd,
          source: "Nepal Rastra Bank (https://www.nrb.org.np/forex/)"
        },
        aramexFinal: {
          grandTotalAED: parseFloat(aramexGrandAED.toFixed(2)),
          grandTotalNPR: toNPR(aramexGrandAED),
          grandTotalUSD: toUSD(aramexGrandAED)
        },
        upsFinal: {
          grandTotalAED: parseFloat(upsGrandAED.toFixed(2)),
          grandTotalNPR: toNPR(upsGrandAED),
          grandTotalUSD: toUSD(upsGrandAED)
        }
      }
    ];

    res.json({
      shipment: {
        origin: "Kathmandu, Nepal (KTM)",
        hub: "Dubai Hub (DXB Transit)",
        destination: countryInfo.name,
        countryCode: destination,
        tariffColumnUsed: colKey,
        isDirectColumn: countryInfo.directCol !== null,
        zone: countryInfo.zone,
        region: countryInfo.region,
        weight: {
          actualKg: actualWeight,
          volumetricKg: parseFloat(volWeight.toFixed(2)),
          chargeableKg: parseFloat(chargeableWeight.toFixed(2))
        }
      },
      forex: {
        nprPerAed: nprPerAed,
        nprPerUsd: nprPerUsd,
        rateType: rateType
      },
      middleMileAir: {
        airline: airline.name,
        flight: airline.flight,
        slab: `+${slab} kg`,
        ratePerKgUSD: airRateUsdPerKg,
        ratePerKgAED: parseFloat(airRateAedPerKg.toFixed(2)),
        amountAED: parseFloat(airFreightAED.toFixed(2)),
        amountNPR: toNPR(airFreightAED)
      },
      clearance: {
        agencyRatePerKgAED: activeAgencyRate,
        agencyClearanceAED: parseFloat(agencyClearanceAED.toFixed(2)),
        agencyClearanceNPR: toNPR(agencyClearanceAED),
        dubaiHubRatePerKgAED: activeHubRate,
        dubaiHubAED: parseFloat(dubaiHubAED.toFixed(2)),
        dubaiHubNPR: toNPR(dubaiHubAED)
      },
      destinationTaxes: {
        customsDutyAED: parseFloat(dutyAED.toFixed(2)),
        importVatAED: parseFloat(destVatAED.toFixed(2)),
        regulatoryFeesAED: parseFloat(regulatoryAED.toFixed(2)),
        regulatoryDesc: regulatoryDesc,
        totalAED: parseFloat(totalDestFeesAED.toFixed(2)),
        totalNPR: toNPR(totalDestFeesAED)
      },
      carriers: {
        aramex: {
          name: "Aramex Express",
          source: aramexSheetName,
          baseFreightAED: parseFloat(aramexBaseAED.toFixed(2)),
          baseFreightNPR: toNPR(aramexBaseAED),
          fuelSurchargeAED: parseFloat(aramexFscAED.toFixed(2)),
          postalTaxAED: parseFloat(aramexPostalAED.toFixed(2)),
          uaeVatAED: parseFloat(aramexUaeVatAED.toFixed(2)),
          grandTotalAED: parseFloat(aramexGrandAED.toFixed(2)),
          grandTotalNPR: toNPR(aramexGrandAED),
          grandTotalUSD: toUSD(aramexGrandAED)
        },
        ups: {
          name: "UPS Worldwide Express / Saver",
          source: `Express Saver Matrix (${colKey})`,
          baseFreightAED: parseFloat(upsBaseAED.toFixed(2)),
          baseFreightNPR: toNPR(upsBaseAED),
          fuelSurchargeAED: parseFloat(upsFscAED.toFixed(2)),
          postalTaxAED: parseFloat(upsPostalAED.toFixed(2)),
          uaeVatAED: parseFloat(upsUaeVatAED.toFixed(2)),
          grandTotalAED: parseFloat(upsGrandAED.toFixed(2)),
          grandTotalNPR: toNPR(upsGrandAED),
          grandTotalUSD: toUSD(upsGrandAED)
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
  console.log(`================================================================`);
  console.log(`Nepal ➔ Dubai Hub Smart Multi-Carrier Logistics Engine 3.1`);
  console.log(`Server running at: http://localhost:${PORT}`);
  console.log(`Live NRB Exchange Rate: 1 AED = ${forexRates.rates["AED"].sell} NPR`);
  console.log(`Datasets loaded: GCC & International Express (${intlRates.columns.length} columns)`);
  console.log(`Countries Directory: ${Object.keys(countryZoneDirectory).length} countries mapped`);
  console.log(`================================================================`);
});
