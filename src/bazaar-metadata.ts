/**
 * GENERATED Bazaar discovery metadata (board #784) — emitted by the official
 * @x402/extensions declareDiscoveryExtension so the `schema` key matches what
 * the CDP indexer validates. Regenerate (rather than hand-edit) if the send/
 * credit request schema changes: see the generator invocation in git history
 * for commit that added this file. Baked as data so the SDK stays out of the
 * worker bundle.
 */

export const SEND_BAZAAR: Record<string, unknown> = {
  "info": {
    "input": {
      "type": "http",
      "method": "POST",
      "bodyType": "json",
      "body": {
        "content_type": "text/plain",
        "body_b64": "aGVsbG8gZnV0dXJlIHNlbGY=",
        "ttl_days": 30,
        "idempotency_key": "example-1"
      },
      "pathParams": {
        "address": "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B"
      }
    },
    "output": {
      "type": "json",
      "example": {
        "message_id": "lm_mssqfu37dsc32ksm",
        "expires_at": "2026-09-13T00:00:00.000Z"
      }
    }
  },
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "input": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "const": "http"
          },
          "method": {
            "type": "string",
            "enum": [
              "POST",
              "PUT",
              "PATCH"
            ]
          },
          "bodyType": {
            "type": "string",
            "enum": [
              "json",
              "form-data",
              "text"
            ]
          },
          "body": {
            "properties": {
              "content_type": {
                "type": "string",
                "description": "MIME type of the message body"
              },
              "body_b64": {
                "type": "string",
                "description": "Inline body, base64-encoded, up to 32KB. Larger: body_upload:true + size_bytes, then PUT to upload_url."
              },
              "body_upload": {
                "type": "boolean",
                "description": "Large-body mode (up to 10MB)"
              },
              "size_bytes": {
                "type": "number",
                "description": "Declared size when body_upload is true"
              },
              "encrypted": {
                "type": "boolean",
                "description": "Body is sealed-box ciphertext for the recipient directory key"
              },
              "ttl_days": {
                "type": "number",
                "description": "Retention, 1-365 days (default 30); priced per 90d extension"
              },
              "idempotency_key": {
                "type": "string",
                "description": "Makes retries safe - strongly recommended"
              },
              "producer": {
                "type": "string",
                "description": "Who you are, so the recipient can filter"
              },
              "tag": {
                "type": "string",
                "description": "Recipient-side filter tag"
              },
              "product": {
                "type": "string",
                "description": "message (default) or receipt_vault (flat $0.02, 365d, <=32KB)"
              }
            },
            "required": [
              "content_type"
            ]
          },
          "pathParams": {
            "type": "object",
            "properties": {
              "address": {
                "type": "string",
                "description": "Recipient EVM wallet address - the mailbox identity"
              }
            }
          }
        },
        "required": [
          "type",
          "method",
          "bodyType",
          "body"
        ],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string"
          },
          "example": {
            "type": "object"
          }
        },
        "required": [
          "type"
        ]
      }
    },
    "required": [
      "input"
    ]
  }
};

export const CREDIT_BAZAAR: Record<string, unknown> = {
  "info": {
    "input": {
      "type": "http",
      "method": "POST",
      "bodyType": "json",
      "body": {
        "amount_microusd": 1000000
      },
      "pathParams": {
        "address": "0x5c7872C6aA7Da867F52733Cebf469f4b9A113f2B"
      }
    },
    "output": {
      "type": "json",
      "example": {
        "credited_microusd": 1000000,
        "paid": true
      }
    }
  },
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "input": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "const": "http"
          },
          "method": {
            "type": "string",
            "enum": [
              "POST",
              "PUT",
              "PATCH"
            ]
          },
          "bodyType": {
            "type": "string",
            "enum": [
              "json",
              "form-data",
              "text"
            ]
          },
          "body": {
            "properties": {
              "amount_microusd": {
                "type": "number",
                "description": "Top-up in atomic USDC units (min 1000000 = $1, balance cap $100)"
              }
            },
            "required": [
              "amount_microusd"
            ]
          },
          "pathParams": {
            "type": "object",
            "properties": {
              "address": {
                "type": "string",
                "description": "Wallet address whose storage credit to fund"
              }
            }
          }
        },
        "required": [
          "type",
          "method",
          "bodyType",
          "body"
        ],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string"
          },
          "example": {
            "type": "object"
          }
        },
        "required": [
          "type"
        ]
      }
    },
    "required": [
      "input"
    ]
  }
};
