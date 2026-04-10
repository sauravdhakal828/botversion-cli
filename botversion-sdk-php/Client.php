<?php
// botversion-sdk-php/Client.php

class BotVersionClient
{
    const SDK_VERSION = "1.0.0";

    private $apiKey;
    private $platformUrl;
    private $debug;
    private $timeout;
    private $queue = [];
    private $flushDelay;

    public function __construct(array $options)
    {
        $this->apiKey      = $options['api_key'];
        $this->platformUrl = $options['platform_url'] ?? 'https://app.botversion.com';
        $this->debug       = $options['debug'] ?? false;
        $this->timeout     = $options['timeout'] ?? 5;
        $this->flushDelay  = $options['flush_delay'] ?? 3;
    }

    // ── Register endpoints (batched) ─────────────────────────────────────────

    public function registerEndpoints(array $endpoints): void
    {
        if (empty($endpoints)) return;

        if ($this->debug) {
            error_log("[BotVersion SDK] Queuing " . count($endpoints) . " endpoints for registration");
        }

        $this->queue = array_merge($this->queue, $endpoints);
        $this->flush();
    }

    // ── Flush batch ──────────────────────────────────────────────────────────

    public function flush(): void
    {
        if (empty($this->queue)) return;

        $toSend      = $this->queue;
        $this->queue = [];

        if ($this->debug) {
            error_log("[BotVersion SDK] Flushing " . count($toSend) . " endpoints to platform");
        }

        try {
            $data = $this->post('/api/sdk/register-endpoints', [
                'workspaceKey' => $this->apiKey,
                'endpoints'    => $toSend,
            ]);

            if ($this->debug) {
                $succeeded = $data['succeeded'] ?? count($toSend);
                error_log("[BotVersion SDK] Registered {$succeeded} endpoints successfully");
            }
        } catch (\Exception $e) {
            if ($this->debug) {
                error_log("[BotVersion SDK] ⚠ Failed to register endpoints: " . $e->getMessage());
            }
        }
    }

    // ── Update single endpoint (runtime) ─────────────────────────────────────

    public function updateEndpoint(array $endpoint): void
    {
        try {
            $this->post('/api/sdk/update-endpoint', [
                'workspaceKey' => $this->apiKey,
                'method'       => $endpoint['method'] ?? null,
                'path'         => $endpoint['path'] ?? null,
                'requestBody'  => $endpoint['request_body'] ?? null,
                'detectedBy'   => $endpoint['detected_by'] ?? 'runtime',
            ]);
        } catch (\Exception $e) {
            if ($this->debug) {
                error_log("[BotVersion SDK] ⚠ Failed to update endpoint: " . $e->getMessage());
            }
        }
    }

    // ── Get all endpoints ────────────────────────────────────────────────────

    public function getEndpoints(): array
    {
        return $this->get('/api/sdk/get-endpoints?workspaceKey=' . urlencode($this->apiKey));
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    private function post(string $path, array $data): array
    {
        $url  = $this->platformUrl . $path;
        $body = json_encode($data);

        $context = stream_context_create([
            'http' => [
                'method'  => 'POST',
                'header'  => implode("\r\n", [
                    'Content-Type: application/json',
                    'Content-Length: ' . strlen($body),
                    'X-BotVersion-SDK: ' . self::SDK_VERSION,
                ]),
                'content' => $body,
                'timeout' => $this->timeout,
                'ignore_errors' => true,
            ],
        ]);

        $response = file_get_contents($url, false, $context);

        if ($response === false) {
            throw new \RuntimeException("Request to platform failed");
        }

        $parsed = json_decode($response, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new \RuntimeException("Invalid JSON response from platform");
        }

        return $parsed;
    }

    private function get(string $path): array
    {
        $url = $this->platformUrl . $path;

        $context = stream_context_create([
            'http' => [
                'method'  => 'GET',
                'header'  => 'X-BotVersion-SDK: ' . self::SDK_VERSION,
                'timeout' => $this->timeout,
                'ignore_errors' => true,
            ],
        ]);

        $response = file_get_contents($url, false, $context);

        if ($response === false) {
            throw new \RuntimeException("Request to platform failed");
        }

        $parsed = json_decode($response, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new \RuntimeException("Invalid JSON response from platform");
        }

        return $parsed;
    }
}