const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const activitySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User'},
  details: {
    path: { type: String },
    status:{ type: String, enum: ['added', 'updated', 'deleted'] }, // updated, deleted, added
    type: { type: String, enum: ['order', 'expense', 'activity', 'income'] }, // order, expense, activity, income
    actionName: { type: String, enum: ['image'] },
    actionId: String
  },
  changedFields: [{
    label: String,
    value: String,
    changedFrom: String,
    changedTo: String
  }]
}, 
{
  timestamps: true
})

module.exports = mongoose.model("Activity", activitySchema);
