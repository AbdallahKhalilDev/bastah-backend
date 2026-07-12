const mongoose = require("mongoose");
const Category = require("../models/Category");

// GET /api/categories
// Public. Returns every ACTIVE category, sorted by English name.
async function listCategories(req, res, next) {
  // find({ isActive: true }) filters out any category we've hidden. When the DB
  // has no categories yet this simply returns [] — an empty list is a correct,
  // successful answer (status 200), not an error.
  const categories = await Category.find({ isActive: true }).sort({ name: 1 });
  res.json({ categories });
}

// GET /api/categories/:id
// Public. Returns a single category by its MongoDB id.
async function getCategory(req, res, next) {
  // 1. Guard the id FIRST. `:id` comes straight from the URL, so it could be
  //    anything ("abc", "123"...). If it isn't a valid ObjectId, Mongoose's
  //    findById would throw a CastError that our error handler turns into a
  //    generic 500. We'd rather tell the caller clearly it's a bad id (400).
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid category id" });
  }

  // 2. Look it up. A well-formed id that matches nothing returns null — that's
  //    a 404 (the id was shaped correctly but no such category exists).
  const category = await Category.findById(req.params.id);
  if (!category) {
    return next({ status: 404, message: "Category not found" });
  }

  // 3. Success: send the single category back, wrapped in a named key.
  res.json({ category });
}

module.exports = { listCategories, getCategory };
