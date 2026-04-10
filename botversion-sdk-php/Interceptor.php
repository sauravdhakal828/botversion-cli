<?php
// botversion-sdk-php/Interceptor.php

class BotVersionInterceptor
{
    private $client;
    private $options;
    private static $reported = [];

    private const IGNORE_PATHS = [
        '/health',
        '/favicon.ico',
        '/_next',
        '/static',
        '/telescope',
        '/horizon',
    ];

    public function __construct($client, array $options = [])
    {
        $this->client  = $client;
        $this->options = $options;
    }

    // ── Laravel middleware handle method ─────────────────────────────────────

    public function handle($request, \Closure $next)
    {
        $path   = '/' . ltrim($request->path(), '/');
        $method = strtoupper($request->method());

        if (!$this->shouldIgnore($path)) {
            $apiPrefix = $this->options['api_prefix'] ?? null;

            if (!$apiPrefix || str_starts_with($path, $apiPrefix)) {
                $normalizedPath = $this->normalizePath($path);
                $key            = $method . ':' . $normalizedPath;

                if (!isset(self::$reported[$key])) {
                    self::$reported[$key] = true;

                    $bodyStructure = $this->buildBodyStructure($request->all());

                    // Fire and forget — don't block the request
                    $this->reportAsync($method, $normalizedPath, $bodyStructure);
                }
            }
        }

        return $next($request);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function shouldIgnore(string $path): bool
    {
        $ignorePaths = array_merge(self::IGNORE_PATHS, $this->options['exclude'] ?? []);
        foreach ($ignorePaths as $ignore) {
            if (str_starts_with($path, $ignore)) return true;
        }
        return false;
    }

    private function normalizePath(string $path): string
    {
        $segments = explode('/', $path);
        $normalized = [];

        foreach ($segments as $segment) {
            if ($segment === '') {
                $normalized[] = $segment;
                continue;
            }
            // UUID
            if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $segment)) {
                $normalized[] = ':id';
            }
            // Numeric
            elseif (preg_match('/^\d+$/', $segment)) {
                $normalized[] = ':id';
            }
            // MongoDB ObjectId
            elseif (preg_match('/^[0-9a-f]{24}$/i', $segment)) {
                $normalized[] = ':id';
            }
            // Long alphanumeric
            elseif (strlen($segment) >= 16 && preg_match('/[a-zA-Z]/', $segment) && preg_match('/[0-9]/', $segment)) {
                $normalized[] = ':id';
            }
            else {
                $normalized[] = $segment;
            }
        }

        return implode('/', $normalized);
    }

    private function buildBodyStructure(array $body): ?array
    {
        if (empty($body)) return null;

        $sensitiveKeys = ['password', 'token', 'secret', 'apikey', 'api_key', 'creditcard', 'credit_card', 'ssn', 'cvv', 'pin'];
        $structure     = [];

        foreach ($body as $key => $val) {
            $isSensitive = false;
            foreach ($sensitiveKeys as $sk) {
                if (str_contains(strtolower($key), $sk)) {
                    $isSensitive = true;
                    break;
                }
            }

            if ($isSensitive) {
                $structure[$key] = '[redacted]';
            } elseif (is_array($val)) {
                $structure[$key] = 'array';
            } elseif (is_null($val)) {
                $structure[$key] = 'null';
            } elseif (is_bool($val)) {
                $structure[$key] = 'boolean';
            } elseif (is_int($val) || is_float($val)) {
                $structure[$key] = 'number';
            } else {
                $structure[$key] = 'string';
            }
        }

        return $structure;
    }

    private function reportAsync(string $method, string $path, ?array $bodyStructure): void
    {
        // In PHP we can't easily spawn threads, so we report inline
        // but catch all errors so we never crash the app
        try {
            $this->client->updateEndpoint([
                'method'       => $method,
                'path'         => $path,
                'request_body' => $bodyStructure,
                'detected_by'  => 'runtime',
            ]);
        } catch (\Exception $e) {
            if ($this->options['debug'] ?? false) {
                error_log("[BotVersion SDK] ⚠ Failed to report endpoint: " . $e->getMessage());
            }
        }
    }
}