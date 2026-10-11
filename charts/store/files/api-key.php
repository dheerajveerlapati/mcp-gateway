<?php
// Registers the WooCommerce REST API key our MCP server uses.
// The key comes from a Kubernetes Secret, so nobody has to click "Add key"
// in wp-admin. Each run replaces the previous key, which makes rotating it
// as simple as changing the Secret and running `helm upgrade`.

global $wpdb;
$table = $wpdb->prefix . 'woocommerce_api_keys';

$consumer_key    = getenv('WOO_CONSUMER_KEY');
$consumer_secret = getenv('WOO_CONSUMER_SECRET');
$admin           = get_user_by('login', getenv('ADMIN_USER'));

$wpdb->delete($table, ['description' => 'mcp-gateway']);
$wpdb->insert($table, [
    'user_id'         => $admin->ID,
    'description'     => 'mcp-gateway',
    'permissions'     => 'read_write',
    'consumer_key'    => wc_api_hash($consumer_key), // WooCommerce stores only a hash
    'consumer_secret' => $consumer_secret,
    'truncated_key'   => substr($consumer_key, -7),
]);

echo "WooCommerce API key registered\n";
