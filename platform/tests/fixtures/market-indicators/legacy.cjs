/* Frozen arithmetic from legacy StockKline; type annotations removed only. */
function movingAverage(values, period) {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? Number((sum / period).toFixed(4)) : null;
  });
}

function exponentialAverage(values, period) {
  const alpha = 2 / (period + 1);
  let previous = values[0] || 0;
  return values.map((value, index) => {
    previous = index === 0 ? value : value * alpha + previous * (1 - alpha);
    return Number(previous.toFixed(4));
  });
}

function bollinger(values, period, multiple = 2) {
  const mid = movingAverage(values, period);
  return { mid, upper: values.map((_, index) => {
    if (index < period - 1 || mid[index] == null) return null;
    const window = values.slice(index - period + 1, index + 1);
    const mean = mid[index];
    const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
    return Number((mean + deviation * multiple).toFixed(4));
  }), lower: values.map((_, index) => {
    if (index < period - 1 || mid[index] == null) return null;
    const window = values.slice(index - period + 1, index + 1);
    const mean = mid[index];
    const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
    return Number((mean - deviation * multiple).toFixed(4));
  }) };
}


module.exports={movingAverage,exponentialAverage,bollinger};
