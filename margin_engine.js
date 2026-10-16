const fs = require('fs');
const path = require('path');

const marginRulesPath = path.join(__dirname, 'data', 'margin_rules.json');

/**
 * MarginEngine
 * Manages commercial profit margin percentages for freight delivery companies.
 * Supports:
 * - Global default margins across ALL countries
 * - Selective country override margins
 * - Flat margin % across all weights OR tiered margins across distinct weight breaks
 * - Multi-carrier applicability (All carriers, Aramex, UPS)
 * - Calculation strictly in NPR (primary) with secondary AED
 */
class MarginEngine {
  constructor() {
    this.dataFile = marginRulesPath;
    this.rules = this.loadRules();
  }

  loadRules() {
    try {
      if (fs.existsSync(this.dataFile)) {
        return JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      }
    } catch (err) {
      console.error('[MarginEngine] Error reading margin rules:', err.message);
    }

    return {
      enabled: true,
      applyOn: "totalLandedCost",
      currency: "NPR",
      globalRule: {
        type: "weight_tier",
        flatMarginPercent: 15.0,
        weightTiers: [
          { minWeight: 0, maxWeight: 5.0, marginPercent: 20.0, label: "0.1 - 5.0 kg" },
          { minWeight: 5.0, maxWeight: 20.0, marginPercent: 15.0, label: "5.1 - 20.0 kg" },
          { minWeight: 20.0, maxWeight: 50.0, marginPercent: 12.0, label: "20.1 - 50.0 kg" },
          { minWeight: 50.0, maxWeight: 100.0, marginPercent: 10.0, label: "50.1 - 100.0 kg" },
          { minWeight: 100.0, maxWeight: 99999, marginPercent: 8.0, label: "100+ kg" }
        ]
      },
      countryRules: {}
    };
  }

  saveRules() {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(this.rules, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[MarginEngine] Error saving margin rules:', err.message);
      return false;
    }
  }

  getConfig() {
    this.rules = this.loadRules();
    return this.rules;
  }

  saveConfig(newConfig) {
    if (!newConfig || typeof newConfig !== 'object') {
      throw new Error("Invalid configuration object provided.");
    }
    this.rules = {
      ...this.rules,
      ...newConfig,
      lastUpdated: new Date().toISOString()
    };
    this.saveRules();
    return this.rules;
  }

  setGlobalRule(ruleData) {
    this.rules = this.loadRules();
    const type = ruleData.type === 'flat' ? 'flat' : 'weight_tier';
    const flatMarginPercent = parseFloat(ruleData.flatMarginPercent) || 15.0;
    const weightTiers = Array.isArray(ruleData.weightTiers) ? ruleData.weightTiers.map(t => ({
      minWeight: parseFloat(t.minWeight) || 0,
      maxWeight: parseFloat(t.maxWeight) || 99999,
      marginPercent: parseFloat(t.marginPercent) || 0,
      label: t.label || `${t.minWeight} - ${t.maxWeight} kg`
    })) : this.rules.globalRule.weightTiers;

    this.rules.globalRule = {
      type,
      flatMarginPercent,
      weightTiers
    };
    this.rules.lastUpdated = new Date().toISOString();
    this.saveRules();
    return this.rules.globalRule;
  }

  setCountryRule(countryCode, ruleData) {
    this.rules = this.loadRules();
    const cCode = countryCode.toUpperCase();
    if (!this.rules.countryRules) this.rules.countryRules = {};

    const type = ruleData.type === 'flat' ? 'flat' : 'weight_tier';
    const flatMarginPercent = parseFloat(ruleData.flatMarginPercent) || 15.0;
    const carrier = ruleData.carrier || 'all';
    const countryName = ruleData.countryName || cCode;
    const weightTiers = Array.isArray(ruleData.weightTiers) ? ruleData.weightTiers.map(t => ({
      minWeight: parseFloat(t.minWeight) || 0,
      maxWeight: parseFloat(t.maxWeight) || 99999,
      marginPercent: parseFloat(t.marginPercent) || 0,
      label: t.label || `${t.minWeight} - ${t.maxWeight} kg`
    })) : [];

    this.rules.countryRules[cCode] = {
      countryName,
      carrier,
      type,
      flatMarginPercent,
      weightTiers,
      lastUpdated: new Date().toISOString()
    };

    this.rules.lastUpdated = new Date().toISOString();
    this.saveRules();
    return this.rules.countryRules[cCode];
  }

  deleteCountryRule(countryCode) {
    this.rules = this.loadRules();
    const cCode = countryCode.toUpperCase();
    if (this.rules.countryRules && this.rules.countryRules[cCode]) {
      delete this.rules.countryRules[cCode];
      this.rules.lastUpdated = new Date().toISOString();
      this.saveRules();
      return true;
    }
    return false;
  }

  /**
   * Determine the applicable margin percentage for a given country, weight, and carrier
   */
  getApplicableMargin(countryCode = '', weightKg = 20, carrierId = 'all') {
    this.rules = this.loadRules();
    const cCode = (countryCode || '').toUpperCase();
    const w = parseFloat(weightKg) || 1.0;
    const carrier = (carrierId || 'all').toLowerCase();

    if (!this.rules.enabled) {
      return {
        enabled: false,
        marginPercent: 0,
        ruleType: 'disabled',
        ruleDescription: 'Margin calculation is disabled',
        tierLabel: 'None'
      };
    }

    // 1. Check selective country rule
    const countryRule = this.rules.countryRules ? this.rules.countryRules[cCode] : null;
    if (countryRule && (countryRule.carrier === 'all' || countryRule.carrier.toLowerCase() === carrier)) {
      if (countryRule.type === 'flat') {
        return {
          enabled: true,
          marginPercent: countryRule.flatMarginPercent,
          ruleType: 'country',
          ruleDescription: `Country Rule: ${countryRule.countryName} (Flat ${countryRule.flatMarginPercent}%)`,
          tierLabel: `Flat across all weight breaks (${countryRule.flatMarginPercent}%)`
        };
      } else if (countryRule.type === 'weight_tier' && Array.isArray(countryRule.weightTiers) && countryRule.weightTiers.length > 0) {
        // Find matching weight tier
        for (const tier of countryRule.weightTiers) {
          if (w > tier.minWeight && w <= tier.maxWeight) {
            return {
              enabled: true,
              marginPercent: tier.marginPercent,
              ruleType: 'country',
              ruleDescription: `Country Rule: ${countryRule.countryName} (Tier: ${tier.label || `${tier.minWeight}-${tier.maxWeight} kg`})`,
              tierLabel: tier.label || `${tier.minWeight} - ${tier.maxWeight} kg (${tier.marginPercent}%)`
            };
          }
        }
        // Fallback to last tier or flat
        const lastTier = countryRule.weightTiers[countryRule.weightTiers.length - 1];
        return {
          enabled: true,
          marginPercent: lastTier.marginPercent,
          ruleType: 'country',
          ruleDescription: `Country Rule: ${countryRule.countryName} (Max Tier)`,
          tierLabel: lastTier.label || `${lastTier.minWeight}+ kg`
        };
      }
    }

    // 2. Global Default Rule
    const globalRule = this.rules.globalRule || { type: 'flat', flatMarginPercent: 15.0 };
    if (globalRule.type === 'flat') {
      return {
        enabled: true,
        marginPercent: globalRule.flatMarginPercent,
        ruleType: 'global',
        ruleDescription: `Global Default Rule (Flat ${globalRule.flatMarginPercent}%)`,
        tierLabel: `Flat across all weight breaks (${globalRule.flatMarginPercent}%)`
      };
    } else {
      const tiers = globalRule.weightTiers || [];
      for (const tier of tiers) {
        if (w > tier.minWeight && w <= tier.maxWeight) {
          return {
            enabled: true,
            marginPercent: tier.marginPercent,
            ruleType: 'global',
            ruleDescription: `Global Default Rule (Tier: ${tier.label || `${tier.minWeight}-${tier.maxWeight} kg`})`,
            tierLabel: tier.label || `${tier.minWeight} - ${tier.maxWeight} kg (${tier.marginPercent}%)`
          };
        }
      }
      const lastTier = tiers.length > 0 ? tiers[tiers.length - 1] : { marginPercent: 15.0, label: "Default" };
      return {
        enabled: true,
        marginPercent: lastTier.marginPercent,
        ruleType: 'global',
        ruleDescription: `Global Default Rule (Max Tier: ${lastTier.label})`,
        tierLabel: lastTier.label
      };
    }
  }

  /**
   * Apply margin calculation to base cost
   */
  calculatePricing(baseCostNPR, countryCode, weightKg, carrierId = 'all', nprPerAed = 42.23) {
    const marginInfo = this.getApplicableMargin(countryCode, weightKg, carrierId);
    const baseNPR = parseFloat(baseCostNPR) || 0;
    const w = Math.max(parseFloat(weightKg) || 1.0, 0.5);

    const marginPercent = marginInfo.marginPercent;
    const marginAmountNPR = baseNPR * (marginPercent / 100);
    const commercialSellingTotalNPR = baseNPR + marginAmountNPR;
    const commercialSellingRatePerKgNPR = commercialSellingTotalNPR / w;

    // Secondary AED
    const baseAED = baseNPR / nprPerAed;
    const marginAmountAED = marginAmountNPR / nprPerAed;
    const commercialSellingTotalAED = commercialSellingTotalNPR / nprPerAed;
    const commercialSellingRatePerKgAED = commercialSellingTotalAED / w;

    return {
      baseCostNPR: parseFloat(baseNPR.toFixed(2)),
      baseCostAED: parseFloat(baseAED.toFixed(2)),
      marginPercent: parseFloat(marginPercent.toFixed(2)),
      marginAmountNPR: parseFloat(marginAmountNPR.toFixed(2)),
      marginAmountAED: parseFloat(marginAmountAED.toFixed(2)),
      commercialSellingTotalNPR: parseFloat(commercialSellingTotalNPR.toFixed(2)),
      commercialSellingTotalAED: parseFloat(commercialSellingTotalAED.toFixed(2)),
      commercialSellingRatePerKgNPR: parseFloat(commercialSellingRatePerKgNPR.toFixed(2)),
      commercialSellingRatePerKgAED: parseFloat(commercialSellingRatePerKgAED.toFixed(2)),
      ruleType: marginInfo.ruleType,
      ruleDescription: marginInfo.ruleDescription,
      tierLabel: marginInfo.tierLabel
    };
  }
}

module.exports = new MarginEngine();
