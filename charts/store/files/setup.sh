#!/bin/sh
# Turns a fresh WordPress into a working WooCommerce shop.
# Runs after every helm install/upgrade, so every step is safe to repeat.
set -eu

echo "Waiting for WordPress files and the database..."
until [ -f wp-config.php ] && wp db check --quiet >/dev/null 2>&1; do sleep 5; done

if ! wp core is-installed; then
  wp core install --url="$SITE_URL" --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" --admin_password="$ADMIN_PASSWORD" \
    --admin_email="$ADMIN_EMAIL" --skip-email
fi

# Keep the URL in sync with the Helm values (e.g. moving from local to prod).
wp option update home "$SITE_URL"
wp option update siteurl "$SITE_URL"

# Pretty permalinks, so the REST API is served at /wp-json/...
wp rewrite structure '/%postname%/'

# Install or upgrade WooCommerce and the Storefront theme to the pinned versions.
if [ "$(wp plugin get woocommerce --field=version 2>/dev/null || true)" != "$WOO_VERSION" ]; then
  wp plugin install woocommerce --version="$WOO_VERSION" --force
fi
wp plugin activate woocommerce
wp wc update # run database migrations after an upgrade (no-op otherwise)

if [ "$(wp theme get storefront --field=version 2>/dev/null || true)" != "$STOREFRONT_VERSION" ]; then
  wp theme install storefront --version="$STOREFRONT_VERSION" --force
fi
wp theme activate storefront

# Shop settings.
wp option update woocommerce_currency "$CURRENCY"
wp option update woocommerce_coming_soon no # new shops start hidden from visitors
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp wc tool run install_pages --user="$ADMIN_USER" # shop, cart, checkout, my-account

# Cash on delivery: the test-friendly payment method used in the demo.
wp option update woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}'

# REST API key for our MCP server (value comes from the Kubernetes Secret).
wp eval-file /setup/api-key.php

if [ "$SAMPLE_PRODUCTS" = "true" ] && [ "$(wp wc product list --user="$ADMIN_USER" --format=count)" = "0" ]; then
  wp wc product create --user="$ADMIN_USER" --name="Classic T-Shirt" --regular_price=499
  wp wc product create --user="$ADMIN_USER" --name="Coffee Mug" --regular_price=299
  wp wc product create --user="$ADMIN_USER" --name="Canvas Tote Bag" --regular_price=399
fi

echo "Store setup complete: $SITE_URL"
