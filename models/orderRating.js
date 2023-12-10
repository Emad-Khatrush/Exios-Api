const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const OrderRatingSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User'},
  order: { type: Schema.Types.ObjectId, ref: 'Order'},
  questions: [{
    name: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['single-choice', 'multiple-choice', 'text', 'rating'],
      default: 'text',
      required: true
    },
    label: {
      type: String,
      required: true
    },
    value: {
      type: Schema.Types.Mixed,
      required: true
    },
  }]
}, 
{
  timestamps: true
})

module.exports = mongoose.model("OrderRating", OrderRatingSchema);
