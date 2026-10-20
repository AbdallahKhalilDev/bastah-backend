// Turn an English name into a URL-safe slug:
//   "Electronics & Home" -> "electronics-home"   "Men's T-Shirt" -> "men-s-t-shirt"
// Lowercase everything, replace any run of non-alphanumeric characters with a
// single dash, then trim dashes off the ends.
//
// Shared by the category and area seeds (their `slug` field) and the product-image
// seed (which matches an image FILE NAME to a product by this slug), so all three
// agree on exactly the same rule.
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = slugify;
