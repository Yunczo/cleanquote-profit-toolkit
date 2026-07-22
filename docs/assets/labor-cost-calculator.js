const clampNumber = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function calculateLaborRate({
  wage,
  burdenPercent,
  nonBillablePercent,
  monthlyOverhead,
  monthlyBillableHours,
  targetMarginPercent,
}) {
  const baseWage = Math.max(0, clampNumber(wage));
  const burden = Math.min(5, Math.max(0, clampNumber(burdenPercent) / 100));
  const nonBillable = Math.min(0.95, Math.max(0, clampNumber(nonBillablePercent) / 100));
  const overhead = Math.max(0, clampNumber(monthlyOverhead));
  const billableHours = Math.max(1, clampNumber(monthlyBillableHours, 1));
  const margin = Math.min(0.95, Math.max(0, clampNumber(targetMarginPercent) / 100));

  const loadedPaidHour = baseWage * (1 + burden);
  const laborPerBillableHour = loadedPaidHour / (1 - nonBillable);
  const overheadPerBillableHour = overhead / billableHours;
  const breakEvenRate = laborPerBillableHour + overheadPerBillableHour;
  const targetHourlyRate = breakEvenRate / (1 - margin);
  const plannedProfitPerHour = targetHourlyRate - breakEvenRate;

  return {
    loadedPaidHour,
    laborPerBillableHour,
    overheadPerBillableHour,
    breakEvenRate,
    targetHourlyRate,
    plannedProfitPerHour,
  };
}

const form = typeof document === "undefined" ? null : document.querySelector("#labor-rate-form");

if (form) {
  const currency = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const output = (name, value) => {
    document.querySelectorAll(`[data-output="${name}"]`).forEach((element) => {
      element.textContent = currency.format(value);
    });
  };

  const update = () => {
    const values = Object.fromEntries(new FormData(form).entries());
    const result = calculateLaborRate(values);
    output("target-rate", result.targetHourlyRate);
    output("loaded-wage", result.loadedPaidHour);
    output("productive-labor", result.laborPerBillableHour);
    output("overhead-hour", result.overheadPerBillableHour);
    output("break-even", result.breakEvenRate);
    output("profit-hour", result.plannedProfitPerHour);
  };

  form.addEventListener("input", update);
  form.addEventListener("submit", (event) => event.preventDefault());
  update();
}
