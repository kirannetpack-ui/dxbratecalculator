# Nepal ➔ Dubai Hub Smart Logistics & Total Landed Cost Engine

A specialized multi-carrier transshipment pricing platform designed for cross-border freight consolidation originating in **Nepal (Kathmandu - KTM)**, transiting through the **Dubai Hub (DXB)**, and delivered via **Aramex** (for GCC) and **UPS** (for Global).

---

## 1. Quick Start

### Prerequisites
- Node.js (v18+ or v24+)
- npm

### Installation & Run
```bash
# Navigate to the project directory
cd "C:\Users\97798\.gemini\antigravity\scratch\nepal_dubai_logistics_engine"

# Start the server
node server.js
```

The application will be live at:
👉 **`http://localhost:3000`**

---

## 2. Real-Time Exchange Rates (Nepal Rastra Bank)

The system automatically synchronizes with the official [Nepal Rastra Bank Forex API](https://www.nrb.org.np/forex/):

| Currency | Buy Rate (NPR) | Sell Rate (NPR) | Base Currency |
| :--- | :---: | :---: | :--- |
| **UAE Dirham (AED)** | **42.06** | **42.23** | 1 AED |
| **U.S. Dollar (USD)** | **154.48** | **155.08** | 1 USD |
| **Saudi Riyal (SAR)** | **41.15** | **41.31** | 1 SAR |
| **Qatari Riyal (QAR)** | **42.42** | **42.58** | 1 QAR |
| **Kuwaiti Dinar (KWD)** | **501.31** | **503.26** | 1 KWD |
| **Bahraini Dinar (BHD)** | **409.11** | **410.70** | 1 BHD |
| **Omani Rial (OMR)** | **401.24** | **402.80** | 1 OMR |

*Supports toggling between Selling Rate and Buying Rate.*

---

## 3. End-to-End Transshipment Legs

```
[Origin: Nepal (Kathmandu - KTM)]
               │
               ▼
   [Middle-Mile Air Cargo: KTM ➔ DXB]
   • Slabs: +100 kg, +300 kg (Default), +500 kg, +1000 kg
   • Airlines: Flydubai (FZ), Nepal Airlines (RA), Air Arabia (G9), Himalaya Airlines (H9)
               │
               ▼
   [Dubai Transit Hub: DXB]
   • Terminal THC Handling (AED 35.00)
   • Transit Customs Bayan (AED 45.00)
   • De-consolidation & Barcode Labeling (AED 20.00)
   • Airport Security & Gate Pass (AED 15.00)
               │
               ▼
   [Last-Mile Delivery (LMD) Carriers ex-Dubai Hub]
   • ARAMEX Express (via ESHIPPER) ──▶ Priority for GCC (KSA, Oman, Kuwait, Bahrain, Qatar)
   • UPS Worldwide                ──▶ Priority for International (US, UK, Europe, Global)
               │
               ▼
   [Destination Customs & DDP Clearance]
   • Destination Import VAT (15% KSA, 10% Bahrain, 5% Oman)
   • Destination Customs Duty (5% if declared value exceeds de minimis)
   • Regulatory Fees (ZATCA 15 SAR, Bayan Stamps, TRA Fees, DDP Admin)
```

---

## 4. REST API Documentation

### `GET /api/forex/nrb`
Returns active NRB exchange rates for AED, USD, SAR, QAR, KWD, BHD, OMR, etc.

### `POST /api/forex/sync`
Fetches the latest live rates directly from `https://www.nrb.org.np/api/forex/v1/rates`.

### `POST /api/calculate`
Calculates total landed costs with dual-currency breakdown.

**Request Payload:**
```json
{
  "actualWeight": 3.0,
  "dimL": 30,
  "dimW": 25,
  "dimH": 20,
  "destination": "KSA",
  "declaredValueUSD": 220,
  "airline": "flydubai",
  "slab": "300",
  "carrier": "aramex",
  "rateType": "sell"
}
```

**Response:**
```json
{
  "route": { ... },
  "weight": { "chargeableKg": 3.0 },
  "forex": { "nprPerAed": 42.23, "nprPerUsd": 155.08 },
  "costs": {
    "airLineHaul_KTM_DXB": { "amountAED": 11.57, "amountNPR": 488.53 },
    "dubaiHubClearance": { "amountAED": 115.00, "amountNPR": 4856.45 },
    "lastMileBaseFreight": { "amountAED": 52.49, "amountNPR": 2216.65 },
    "carrierSurcharges": { "totalAED": 21.62, "totalNPR": 912.81 },
    "destinationCustomsAndDDP": { "totalAED": 161.60, "totalNPR": 6824.37 },
    "grandTotal": {
      "currency_AED": 362.27,
      "currency_NPR": 15298.81,
      "currency_USD": 98.64
    }
  }
}
```
