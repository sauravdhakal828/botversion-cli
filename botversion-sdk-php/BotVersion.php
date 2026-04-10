<?php
// botversion-sdk-php/BotVersion.php

require_once __DIR__ . '/Client.php';
require_once __DIR__ . '/Scanner.php';
require_once __DIR__ . '/Interceptor.php';

class BotVersion
{
    private static $initialized = false;
    private static $client      = null;

    /**
     * Initialize the BotVersion SDK.
     *
     * Auto-detects Laravel — no framework config needed.
     *
     * Usage (in bootstrap/app.php or AppServiceProvider):
     *   BotVersion::init('YOUR_API_KEY');
     *
     * Optional config:
     *   BotVersion::init('YOUR_API_KEY', [
     *     'debug'      => true,
     *     'exclude'    => ['/health', '/internal'],
     *     'api_prefix' => '/api',
     *   ]);
     */
    public static function init(string $apiKey, array $options = []): void
    {
        if (self::$initialized) {
            error_log("[BotVersion SDK] ⚠ Already initialized — skipping");
            return;
        }

        if (empty($apiKey)) {
            error_log("[BotVersion SDK] ❌ api_key is required.");
            return;
        }

        self::$initialized = true;
        $debug = $options['debug'] ?? false;

        if ($debug) {
            error_log("[BotVersion SDK] Initializing...");
        }

        self::$client = new BotVersionClient([
            'api_key'      => $apiKey,
            'platform_url' => $options['platform_url'] ?? 'https://app.botversion.com',
            'debug'        => $debug,
            'timeout'      => $options['timeout'] ?? 5,
        ]);

        // ── Detect framework ─────────────────────────────────────────────────
        $framework = self::detectFramework();

        if (!$framework) {
            error_log("[BotVersion SDK] ❌ Could not detect framework. Only Laravel is currently supported.");
            return;
        }

        if ($debug) {
            error_log("[BotVersion SDK] ✅ Framework detected: {$framework}");
        }

        $interceptorOptions = [
            'exclude'    => $options['exclude'] ?? [],
            'api_prefix' => $options['api_prefix'] ?? null,
            'debug'      => $debug,
        ];

        // ── Register Laravel middleware ───────────────────────────────────────
        if ($framework === 'laravel') {
            self::attachLaravelMiddleware($interceptorOptions);
        }

        // ── Static scan (delayed via booted callback) ─────────────────────────
        // Use Laravel's booted hook so all routes are registered before scanning
        if (function_exists('app') && method_exists(app(), 'booted')) {
            app()->booted(function () use ($debug) {
                try {
                    if ($debug) {
                        error_log("[BotVersion SDK] Scanning Laravel routes...");
                    }

                    $endpoints = BotVersionScanner::scanLaravelRoutes();

                    if ($debug) {
                        error_log("[BotVersion SDK] Found " . count($endpoints) . " routes");
                    }

                    if (empty($endpoints)) {
                        error_log("[BotVersion SDK] ⚠ No endpoints found.");
                        error_log("[BotVersion SDK] ⚠ Make sure BotVersion::init() is called in a ServiceProvider.");
                        return;
                    }

                    self::$client->registerEndpoints($endpoints);

                    if ($debug) {
                        error_log("[BotVersion SDK] ✅ Initialization complete — " . count($endpoints) . " endpoints registered");
                    }
                } catch (\Exception $e) {
                    if ($debug) {
                        error_log("[BotVersion SDK] ⚠ Scan error: " . $e->getMessage());
                    }
                }
            });
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public static function getEndpoints(): array
    {
        if (!self::$client) {
            throw new \RuntimeException("BotVersion SDK not initialized. Call BotVersion::init() first.");
        }
        return self::$client->getEndpoints();
    }

    public static function registerEndpoint(array $endpoint): void
    {
        if (!self::$client) {
            throw new \RuntimeException("BotVersion SDK not initialized.");
        }
        self::$client->registerEndpoints([$endpoint]);
    }

    // ── Framework detection ───────────────────────────────────────────────────

    private static function detectFramework(): ?string
    {
        // Check for Laravel — app() helper and Illuminate kernel
        if (function_exists('app') && class_exists('\Illuminate\Foundation\Application')) {
            return 'laravel';
        }
        return null;
    }

    // ── Attach Laravel middleware ─────────────────────────────────────────────

    private static function attachLaravelMiddleware(array $options): void
    {
        try {
            $interceptor = new BotVersionInterceptor(self::$client, $options);

            // Push middleware into Laravel's HTTP kernel
            app(\Illuminate\Contracts\Http\Kernel::class)
                ->pushMiddleware(function ($request, $next) use ($interceptor) {
                    return $interceptor->handle($request, $next);
                });

            if ($options['debug'] ?? false) {
                error_log("[BotVersion SDK] ✅ Laravel middleware attached");
            }
        } catch (\Exception $e) {
            error_log("[BotVersion SDK] ⚠ Failed to attach middleware: " . $e->getMessage());
        }
    }
}