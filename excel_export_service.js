const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const marginEngine = require('./margin_engine');

const dataDir = path.join(__dirname, 'data');
const gccRatesPath = path.join(dataDir, 'gcc_rates.json');
const intlRatesPath = path.join(dataDir, 'international_express_rates.json');
const countryZonePath = path.join(dataDir, 'country_zone_directory.json');
const airlinesPath = path.join(dataDir, 'airlines.json');
const fuelSurchargesPath = path.join(dataDir, 'fuel_surcharges.json');

/**
 * ExcelExportService
 * Generates official Excel Rate Sheet & Zone Directory in Nepalese Rupees (NPR).
 * All tariffs converted from Dubai Hub AED using NRB Forex Rate.
 * Includes complete margin matrices for all delivery companies.
 */
class ExcelExportService {
  constructor() {
    this.defaultNprPerAed = 42.23;
  }

  generateWorkbook(nprPerAed = this.defaultNprPerAed) {
    const rateNpr = parseFloat(nprPerAed) || this.defaultNprPerAed;
    const gccRates = JSON.parse(fs.readFileSync(gccRatesPath, 'utf8'));
    const intlRates = JSON.parse(fs.readFileSync(intlRatesPath, 'utf8'));
    const countryZoneDirectory = JSON.parse(fs.readFileSync(countryZonePath, 'utf8'));
    const airlinesData = JSON.parse(fs.readFileSync(airlinesPath, 'utf8'));
    const fuelData = JSON.parse(fs.readFileSync(fuelSurchargesPath, 'utf8'));
    const marginConfig = marginEngine.getConfig();

    const wb = XLSX.utils.book_new();

    // =========================================================================
    // SHEET 1: Country & Zone Directory
    // =========================================================================
    const zoneRows = [];
    zoneRows.push([
      "Country Name",
      "ISO-2 Code",
      "Region",
      "Aramex GCC Service",
      "UPS Express Zone",
      "Direct Tariff Col",
      "Margin (0-5 kg)",
      "Margin (5-20 kg)",
      "Margin (20-50 kg)",
      "Margin (50-100 kg)",
      "Margin (100+ kg)",
      "Pricing Currency"
    ]);

    const sortedCountries = Object.keys(countryZoneDirectory).sort((a, b) => {
      const nameA = countryZoneDirectory[a].name || a;
      const nameB = countryZoneDirectory[b].name || b;
      return nameA.localeCompare(nameB);
    });

    sortedCountries.forEach(code => {
      const c = countryZoneDirectory[code];
      const m0 = marginEngine.getApplicableMargin(code, 2.5, 'all').marginPercent;
      const m5 = marginEngine.getApplicableMargin(code, 10.0, 'all').marginPercent;
      const m20 = marginEngine.getApplicableMargin(code, 30.0, 'all').marginPercent;
      const m50 = marginEngine.getApplicableMargin(code, 75.0, 'all').marginPercent;
      const m100 = marginEngine.getApplicableMargin(code, 150.0, 'all').marginPercent;

      zoneRows.push([
        c.name || code,
        c.code || code,
        c.region || "Global",
        c.aramexService || (code === "BH" || code === "OM" || code === "KW" || code === "QA" || code === "SA" ? "GCC Dedicated Network" : "Non-GCC"),
        c.zone || "4",
        c.directCol || "N/A",
        `${m0.toFixed(1)}%`,
        `${m5.toFixed(1)}%`,
        `${m20.toFixed(1)}%`,
        `${m50.toFixed(1)}%`,
        `${m100.toFixed(1)}%`,
        "NPR (Nepalese Rupees)"
      ]);
    });

    const wsZones = XLSX.utils.aoa_to_sheet(zoneRows);
    wsZones['!cols'] = [
      { wch: 28 }, { wch: 12 }, { wch: 24 }, { wch: 24 }, { wch: 18 }, { wch: 16 },
      { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 22 }
    ];
    XLSX.utils.book_append_sheet(wb, wsZones, "Countries & Zones");

    // =========================================================================
    // SHEET 2: Aramex GCC Tariff (in NPR)
    // =========================================================================
    const aramexRows = [];
    aramexRows.push(["ARAMEX EXPRESS - DEDICATED GCC NON-DOC TARIFF (STRICTLY IN NEPALESE RUPEES)"]);
    aramexRows.push([`Base Conversion: 1 AED = NPR ${rateNpr.toFixed(2)} (NRB Forex Benchmark) | Sourced FSC: ${fuelData.aramex.ratePercent}% | Zero Postal Tax`]);
    aramexRows.push([]);
    aramexRows.push([
      "Weight Slab (kg)",
      "Bahrain (BH) - Base NPR",
      "Bahrain (BH) - Sell NPR",
      "Oman (OM) - Base NPR",
      "Oman (OM) - Sell NPR",
      "Kuwait (KW) - Base NPR",
      "Kuwait (KW) - Sell NPR",
      "Qatar (QA) - Base NPR",
      "Qatar (QA) - Sell NPR",
      "Saudi Arabia (SA) - Base NPR",
      "Saudi Arabia (SA) - Sell NPR"
    ]);

    const weightSlabs = ["0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "Every Addtnl kg"];
    const gccCountryKeys = [
      { code: "BH", name: "Bahrain" },
      { code: "OM", name: "Oman" },
      { code: "KW", name: "Kuwait" },
      { code: "QA", name: "Qatar" },
      { code: "SA", name: "KSA" }
    ];

    weightSlabs.forEach(slab => {
      const slabWeightNum = slab === "Every Addtnl kg" ? 1.0 : parseFloat(slab);
      const row = [slab === "Every Addtnl kg" ? "Every Addtnl kg (NPR/kg)" : `${slab} kg`];

      gccCountryKeys.forEach(ck => {
        const aedRate = (gccRates[ck.name] && gccRates[ck.name][slab]) || 0;
        const baseNpr = aedRate * rateNpr;
        const marginInfo = marginEngine.getApplicableMargin(ck.code, slabWeightNum, 'aramex');
        const sellNpr = baseNpr * (1 + marginInfo.marginPercent / 100);

        row.push(parseFloat(baseNpr.toFixed(2)));
        row.push(parseFloat(sellNpr.toFixed(2)));
      });

      aramexRows.push(row);
    });

    const wsAramex = XLSX.utils.aoa_to_sheet(aramexRows);
    wsAramex['!cols'] = [
      { wch: 25 },
      { wch: 24 }, { wch: 24 },
      { wch: 24 }, { wch: 24 },
      { wch: 24 }, { wch: 24 },
      { wch: 24 }, { wch: 24 },
      { wch: 26 }, { wch: 26 }
    ];
    XLSX.utils.book_append_sheet(wb, wsAramex, "Aramex GCC Rates (NPR)");

    // =========================================================================
    // SHEET 3: UPS Global Express Rates (in NPR)
    // =========================================================================
    const upsRows = [];
    upsRows.push(["UPS WORLDWIDE EXPRESS / SAVER MATRIX (STRICTLY IN NEPALESE RUPEES)"]);
    upsRows.push([`Base Conversion: 1 AED = NPR ${rateNpr.toFixed(2)} (NRB Forex Benchmark) | Sourced FSC: ${fuelData.ups.ratePercent}% | Zero Postal Tax`]);
    upsRows.push([]);

    // Sample major columns from UPS tariff
    const majorUpsCols = ["2", "3", "4", "5", "6", "7", "US", "GB", "IN", "CN", "AU", "DE", "FR", "SA", "BH", "KW", "QA", "OM"];
    const headerRow = ["Weight (kg)", "Product"];
    majorUpsCols.forEach(col => {
      const colLabel = countryZoneDirectory[col] ? `${countryZoneDirectory[col].name} (${col}) - NPR` : `Zone ${col} - NPR`;
      headerRow.push(colLabel);
    });
    upsRows.push(headerRow);

    const intlItems = intlRates.rates || [];
    intlItems.forEach(item => {
      const row = [`${item.weight} kg`, item.product || "Non-Doc"];
      majorUpsCols.forEach(col => {
        const aedVal = (item.rates && item.rates[col]) || 0;
        const nprVal = aedVal * rateNpr;
        row.push(parseFloat(nprVal.toFixed(2)));
      });
      upsRows.push(row);
    });

    const wsUps = XLSX.utils.aoa_to_sheet(upsRows);
    const upsColsMeta = [{ wch: 14 }, { wch: 12 }];
    majorUpsCols.forEach(() => upsColsMeta.push({ wch: 24 }));
    wsUps['!cols'] = upsColsMeta;
    XLSX.utils.book_append_sheet(wb, wsUps, "UPS Global Rates (NPR)");

    // =========================================================================
    // SHEET 4: KTM-DXB Middle-Mile Linehaul & Dubai Clearance (in NPR)
    // =========================================================================
    const linehaulRows = [];
    linehaulRows.push(["MIDDLE-MILE AIR LINEHAUL (KTM ➔ DXB) & DUBAI AGENCY TRANSIT CLEARANCE"]);
    linehaulRows.push(["All rates originating from Tribhuvan International Airport (KTM) to Dubai International Airport (DXB) in NPR"]);
    linehaulRows.push([]);

    linehaulRows.push(["1. KTM-DXB Airline Carriers & Weight Break Slabs (in NPR / kg)"]);
    linehaulRows.push(["Carrier ID", "Airline Name", "Flight Service", "+100 kg Slab", "+300 kg Slab", "+500 kg Slab", "+1000 kg Slab", "Currency"]);

    const airList = Array.isArray(airlinesData) ? airlinesData : (airlinesData.carriers || []);
    airList.forEach(air => {
      const slabs = air.slabs || air.rates || {};
      linehaulRows.push([
        air.id,
        air.name,
        air.flight || air.code || "Direct",
        slabs["100"] || 180,
        slabs["300"] || 160,
        slabs["500"] || 145,
        slabs["1000"] || 130,
        "NPR / kg"
      ]);
    });

    linehaulRows.push([]);
    linehaulRows.push(["2. Dubai Agency Transit Clearance / THC Charges"]);
    linehaulRows.push(["Fee Component", "Standard Billing Rate", "NPR Equivalent Rate", "Billing Type", "Rule Description"]);
    linehaulRows.push([
      "Dubai Agency Transit Clearance",
      "AED 1.00 / kg",
      `NPR ${(1.00 * rateNpr).toFixed(2)} / kg`,
      "Per Chargeable Kg",
      "Single transit agency clearance fee dynamically applied per kg. Zero handling extras."
    ]);

    const wsLinehaul = XLSX.utils.aoa_to_sheet(linehaulRows);
    wsLinehaul['!cols'] = [{ wch: 18 }, { wch: 26 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsLinehaul, "Linehaul & Clearance (NPR)");

    // =========================================================================
    // SHEET 5: End-to-End Landed Cost & Selling Quotation Matrix (in NPR)
    // =========================================================================
    const quoteRows = [];
    quoteRows.push(["COMPLETE END-TO-END COMMERCIAL SELLING QUOTATION MATRIX (STRICTLY IN NEPALESE RUPEES)"]);
    quoteRows.push(["Formula: KTM-DXB Air Linehaul (NPR) + Dubai Agency Clearance (NPR) + Carrier Last-Mile & Surcharges (NPR) + Configured Profit Margin (%)"]);
    quoteRows.push([]);
    quoteRows.push([
      "Destination Country",
      "ISO-2",
      "Carrier",
      "Chargeable Weight (kg)",
      "KTM-DXB Air Linehaul (NPR)",
      "Dubai Clearance (NPR)",
      "Last-Mile Freight (NPR)",
      "Fuel Surcharge (NPR)",
      "Total Landed Cost (NPR)",
      "Profit Margin (%)",
      "Margin Amount (NPR)",
      "Commercial Selling Price (NPR)",
      "Selling Rate / kg (NPR/kg)"
    ]);

    const benchmarkWeights = [1, 2, 5, 10, 20, 30, 50];
    const benchmarkDestinations = [
      { code: "BH", name: "Bahrain", carrier: "Aramex Express" },
      { code: "SA", name: "Saudi Arabia", carrier: "Aramex Express" },
      { code: "KW", name: "Kuwait", carrier: "Aramex Express" },
      { code: "QA", name: "Qatar", carrier: "Aramex Express" },
      { code: "OM", name: "Oman", carrier: "Aramex Express" },
      { code: "US", name: "United States", carrier: "UPS Worldwide Express" },
      { code: "GB", name: "United Kingdom", carrier: "UPS Worldwide Express" },
      { code: "IN", name: "India", carrier: "UPS Worldwide Express" },
      { code: "AU", name: "Australia", carrier: "UPS Worldwide Express" },
      { code: "DE", name: "Germany", carrier: "UPS Worldwide Express" }
    ];

    benchmarkDestinations.forEach(dest => {
      benchmarkWeights.forEach(wt => {
        // Linehaul (Flydubai 300kg slab = 160 NPR/kg as standard benchmark)
        const airNpr = wt * 160;
        // Dubai clearance = AED 1.00/kg * 42.23
        const clearNpr = wt * (1.00 * rateNpr);

        // Carrier Last Mile
        let lastMileAed = 0;
        let fscPct = 14.5;
        if (dest.carrier.includes("Aramex")) {
          fscPct = fuelData.aramex.ratePercent;
          const cName = dest.code === "SA" ? "KSA" : dest.name;
          const table = gccRates[cName] || {};
          if (wt <= 5) {
            lastMileAed = table[wt.toString()] || table["5"] || 50;
          } else {
            const extra = wt - 5;
            lastMileAed = (table["5"] || 50) + (extra * (table["Every Addtnl kg"] || 8));
          }
        } else {
          fscPct = fuelData.ups.ratePercent;
          const cInfo = countryZoneDirectory[dest.code] || { zone: "4" };
          const colKey = cInfo.directCol || cInfo.zone || "4";
          // Look up in international express rates
          const matchItem = intlItems.find(i => parseFloat(i.weight) === wt && i.product === "Non-Doc") || intlItems.find(i => parseFloat(i.weight) === wt);
          if (matchItem && matchItem.rates && matchItem.rates[colKey]) {
            lastMileAed = matchItem.rates[colKey];
          } else {
            lastMileAed = wt * 35; // Fallback estimate
          }
        }

        const lastMileNpr = lastMileAed * rateNpr;
        const fscNpr = lastMileNpr * (fscPct / 100);
        const totalLandedCostNpr = airNpr + clearNpr + lastMileNpr + fscNpr;

        // Apply Margin
        const pricing = marginEngine.calculatePricing(totalLandedCostNpr, dest.code, wt, dest.carrier.includes("Aramex") ? 'aramex' : 'ups', rateNpr);

        quoteRows.push([
          dest.name,
          dest.code,
          dest.carrier,
          wt,
          parseFloat(airNpr.toFixed(2)),
          parseFloat(clearNpr.toFixed(2)),
          parseFloat(lastMileNpr.toFixed(2)),
          parseFloat(fscNpr.toFixed(2)),
          parseFloat(totalLandedCostNpr.toFixed(2)),
          `${pricing.marginPercent.toFixed(1)}%`,
          pricing.marginAmountNPR,
          pricing.commercialSellingTotalNPR,
          pricing.commercialSellingRatePerKgNPR
        ]);
      });
    });

    const wsQuote = XLSX.utils.aoa_to_sheet(quoteRows);
    wsQuote['!cols'] = [
      { wch: 22 }, { wch: 10 }, { wch: 24 }, { wch: 24 },
      { wch: 26 }, { wch: 22 }, { wch: 24 }, { wch: 22 },
      { wch: 24 }, { wch: 18 }, { wch: 20 }, { wch: 28 }, { wch: 26 }
    ];
    XLSX.utils.book_append_sheet(wb, wsQuote, "Landed & Sell Rates (NPR)");

    // =========================================================================
    // SHEET 6: Configured Margin Rules & Policy
    // =========================================================================
    const policyRows = [];
    policyRows.push(["COMMERCIAL PROFIT MARGIN POLICY & OPERATIONAL RULES (IN NPR)"]);
    policyRows.push(["System Configuration for Dynamic Markup across Global and Selective Destinations"]);
    policyRows.push([]);
    policyRows.push(["1. Global Margin Default Policy"]);
    policyRows.push(["Rule Type", marginConfig.globalRule.type === "flat" ? "Flat Margin across all weights" : "Weight-Tiered Margins"]);
    policyRows.push(["Flat Margin Benchmark", `${marginConfig.globalRule.flatMarginPercent}%`]);
    policyRows.push([]);
    policyRows.push(["Weight Bracket (kg)", "Applied Margin (%)", "Operational Bracket Description"]);

    (marginConfig.globalRule.weightTiers || []).forEach(tier => {
      policyRows.push([
        `${tier.minWeight} - ${tier.maxWeight === 99999 ? 'Above' : tier.maxWeight} kg`,
        `${tier.marginPercent}%`,
        tier.label || "Standard Courier Bracket"
      ]);
    });

    policyRows.push([]);
    policyRows.push(["2. Selective Country Override Rules"]);
    policyRows.push(["Country Code", "Country Name", "Rule Type", "Flat %", "Weight Tiers Description"]);

    const countryRules = marginConfig.countryRules || {};
    Object.keys(countryRules).forEach(code => {
      const cr = countryRules[code];
      const tierDesc = cr.type === "flat" ? "Flat across all weights" : (cr.weightTiers || []).map(t => `${t.minWeight}-${t.maxWeight}kg: ${t.marginPercent}%`).join(" | ");
      policyRows.push([
        code,
        cr.countryName || code,
        cr.type,
        cr.type === "flat" ? `${cr.flatMarginPercent}%` : "Tiered",
        tierDesc
      ]);
    });

    const wsPolicy = XLSX.utils.aoa_to_sheet(policyRows);
    wsPolicy['!cols'] = [{ wch: 26 }, { wch: 32 }, { wch: 22 }, { wch: 18 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsPolicy, "Margin Policy");

    return wb;
  }

  saveWorkbookToFile(filePath, nprPerAed = this.defaultNprPerAed) {
    const wb = this.generateWorkbook(nprPerAed);
    XLSX.writeFile(wb, filePath);
    return filePath;
  }

  generateBuffer(nprPerAed = this.defaultNprPerAed) {
    const wb = this.generateWorkbook(nprPerAed);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
}

module.exports = new ExcelExportService();
