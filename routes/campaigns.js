const express = require('express');
const campaigns = require('../controllers/campaigns');
const { protect, isAdmin } = require('../middleware/check-auth');

const router = express.Router();

router.route('/campaigns')
      .get(protect, isAdmin, campaigns.getCampaigns);

router.route('/campaigns/:id')
      .get(protect, isAdmin, campaigns.getCampaign)
      .delete(protect, isAdmin, campaigns.deleteCampaign);

module.exports = router;
