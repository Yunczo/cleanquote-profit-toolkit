"use strict";

const form = document.querySelector("#calculator-form");
const presets = {
  standard: { productivity: 420, supplies: 16 },
  deep: { productivity: 245, supplies: 28 },
  moveout: { productivity: 220, supplies: 34 },
  office: { productivity: 560, supplies: 22 },
  construction: { productivity: 185, supplies: 42 },
};
const frequencyEffort = { "one-time": 1, weekly: 0.72, biweekly: 0.82, monthly: 0.92 };
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function write(id, value) {
  document.querySelector(`#${id}`).textContent = value;
}

function calculate() {
  const data = new FormData(form);
  const preset = presets[data.get("service")];
  const squareFeet = clamp(Number(data.get("squareFeet")), 300, 20000);
  const crewSize = clamp(Number(data.get("crewSize")), 1, 12);
  const laborRate = clamp(Number(data.get("laborRate")), 8, 100);
  const targetMargin = clamp(Number(data.get("targetMargin")), 10, 60);
  const totalLabor = Math.max(1.5, squareFeet / preset.productivity * frequencyEffort[data.get("frequency")]);
  const onSite = totalLabor / crewSize;
  const laborCost = totalLabor * laborRate;
  const addOnRevenue = data.getAll("addon").reduce((sum, value) => sum + Number(value), 0);
  const costFloor = laborCost + preset.supplies + 18 + onSite * 12 + addOnRevenue * 0.35;
  const quote = Math.ceil(((laborCost + preset.supplies + 18 + onSite * 12) / (1 - targetMargin / 100) + addOnRevenue) / 5) * 5;
  const profit = quote - costFloor;
  const margin = profit / quote;

  write("margin-input-value", `${targetMargin}%`);
  write("quote-result", usd.format(quote));
  write("floor-result", usd.format(costFloor));
  write("profit-result", `+${usd.format(profit)}`);
  write("margin-result", `${Math.round(margin * 100)}%`);
  write("labor-result", `${totalLabor.toFixed(1)} hrs`);
  write("time-result", `${onSite.toFixed(1)} hrs`);
  write("hero-quote", usd.format(quote));
  write("hero-floor", usd.format(costFloor));
  write("hero-profit", usd.format(profit));
  write("hero-margin", `${Math.round(margin * 100)}%`);
}

form.addEventListener("input", calculate);
form.addEventListener("change", calculate);
calculate();
