const ExchangeRate = require('../models/exchangeRate');
const ShipmentPrices = require('../models/shipmentPrices');
const ErrorHandler = require('../utils/errorHandler');

module.exports.getPrices = async (req, res, next) => {
  try {
    let prices = await ShipmentPrices.find({});
    if (prices?.length <= 0) {
      await ShipmentPrices.create({
        shippingType: 'air',
        country: 'china',
        sellingPrice: 11,
        currency: 'USD'
      })
      await ShipmentPrices.create({
        shippingType: 'sea',
        country: 'china',
        sellingPrice: 130,
        currency: 'USD'
      })
      await ShipmentPrices.create({
        country: 'uae',
        shippingType: 'air',
        sellingPrice: 8,
        currency: 'USD'
      })
      await ShipmentPrices.create({
        country: 'turkey',
        shippingType: 'air',
        sellingPrice: 3,
        currency: 'USD'
      })
      await ShipmentPrices.create({
        country: 'uk',
        shippingType: 'air',
        sellingPrice: 12,
        currency: 'USD'
      })
      await ShipmentPrices.create({
        country: 'usa',
        shippingType: 'air',
        sellingPrice: 15,
        currency: 'USD'
      })
      prices = await ShipmentPrices.find({});
    }
    res.status(200).json(prices)
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updatePrices = async (req, res, next) => {
  try {
    const data = req.body;
    if (!data) return res.status(200).json({ updatedAt: new Date() });

    for (const key in data) {
      const splitedKeys = key.split('-');
      const country = splitedKeys[0];
      const shippingType = splitedKeys[1];
      await ShipmentPrices.updateOne({ country, shippingType }, {
        $set: {
          sellingPrice: Number(data[key])
        }
      });
    }
    res.status(200).json({ updatedAt: new Date() })
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.getExchangeRate = async (req, res, next) => {
  try {
    let rate = await ExchangeRate.findOne({ fromCurrency: 'usd' });
    if (!rate) {
      await ExchangeRate.create({
        rate: 5.2
      })
      rate = await ExchangeRate.findOne({ fromCurrency: 'usd' });
    }

    res.status(200).json(rate);
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

module.exports.updateExchangeRate = async (req, res, next) => {
  try {
    const exchangeRate = req.body.exchangeRate;
    await ExchangeRate.updateOne({ _id: exchangeRate._id }, {
      $set: {
        rate: exchangeRate.rate
      }
      })
    res.status(200).json({ updatedAt: new Date() });
  } catch (error) {
    return next(new ErrorHandler(404, error.message));
  }
}

// await ShipmentPrices.create({
//   shippingType: 'air',
//   country: 'china',
//   sellingPrice: 11,
//   currency: 'USD'
// })
// await ShipmentPrices.create({
//   shippingType: 'sea',
//   country: 'china',
//   sellingPrice: 130,
//   currency: 'USD'
// })
// await ShipmentPrices.create({
//   country: 'uae',
//   shippingType: 'air',
//   sellingPrice: 8,
//   currency: 'USD'
// })
// await ShipmentPrices.create({
//   country: 'turkey',
//   shippingType: 'air',
//   sellingPrice: 3,
//   currency: 'USD'
// })
// await ShipmentPrices.create({
//   country: 'uk',
//   shippingType: 'air',
//   sellingPrice: 12,
//   currency: 'USD'
// })
// await ShipmentPrices.create({
//   country: 'usa',
//   shippingType: 'air',
//   sellingPrice: 15,
//   currency: 'USD'
// })
