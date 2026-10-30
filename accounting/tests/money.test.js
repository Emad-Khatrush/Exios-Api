const { toMinor, fromMinor, convertToUsdMinor, roundHalfAway } = require('../services/money');
const { toDay, addDays } = require('../services/dates');
const { valueOutflow } = require('../services/carrying');

describe('money', () => {
  test('toMinor does not suffer from float artefacts', () => {
    expect(toMinor(1.005, 2)).toBe(101);
    expect(toMinor(4500, 3)).toBe(4500000);
    expect(toMinor(-0.125, 2)).toBe(-13);
    expect(toMinor('12.34', 2)).toBe(1234);
  });

  test('fromMinor', () => {
    expect(fromMinor(4500000, 3)).toBe(4500);
    expect(fromMinor(1234, 2)).toBe(12.34);
  });

  test('converts foreign minor units to USD cents at units-per-dollar rate', () => {
    expect(convertToUsdMinor(4500000, 3, 9)).toBe(50000); // 4500 LYD @ 9 = 500 $
    expect(convertToUsdMinor(7100000, 2, 7.1)).toBe(1000000); // 71,000 CNY @ 7.1 = 10,000 $
    expect(() => convertToUsdMinor(100, 2, 0)).toThrow();
  });

  test('rounds half away from zero', () => {
    expect(roundHalfAway(2.5)).toBe(3);
    expect(roundHalfAway(-2.5)).toBe(-3);
  });
});

describe('dates use the Libya day', () => {
  test('late UTC evening is already the next day in Tripoli', () => {
    expect(toDay(new Date('2026-01-31T22:30:00Z'))).toBe('2026-02-01');
    expect(toDay(new Date('2026-01-31T21:30:00Z'))).toBe('2026-01-31');
    expect(toDay('2026-03-05')).toBe('2026-03-05');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('carrying rate', () => {
  test('taking out the whole foreign balance takes out the whole USD balance', () => {
    const balance = { foreign: -1900000, usd: -20000 }; // 900@9 + 1000@10 on a wallet (credit)
    expect(valueOutflow(balance, 1900000)).toBe(20000);
    expect(valueOutflow(balance, 950000)).toBe(10000);
  });

  test('no average when the balance is empty or mixed', () => {
    expect(valueOutflow({ foreign: 0, usd: 0 }, 100)).toBeNull();
    expect(valueOutflow({ foreign: 100, usd: -5 }, 100)).toBeNull();
  });
});
