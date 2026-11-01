/*
 * Recover from a half-finished OpenThread key move.
 *
 * DatasetManager::EmplaceSecurelyStoredKeys re-imports every dataset key
 * when any of them is missing from PSA secure storage. If a previous boot
 * stored only some of them (reset or power loss between imports), the
 * import of a key that already exists returns PSA_ERROR_ALREADY_EXISTS and
 * OpenThread asserts on every boot afterwards.
 *
 * Linked in with -Wl,--wrap=psa_import_key (see CMakeLists.txt). A persistent
 * key that already exists is destroyed and imported again, which is what the
 * dataset Save path does.
 */

#include "esp_log.h"
#include "psa/crypto.h"

#define TAG "psa_recover"

psa_status_t __real_psa_import_key(const psa_key_attributes_t *attributes, const uint8_t *data,
                                   size_t data_length, mbedtls_svc_key_id_t *key);

psa_status_t __wrap_psa_import_key(const psa_key_attributes_t *attributes, const uint8_t *data,
                                   size_t data_length, mbedtls_svc_key_id_t *key)
{
    psa_status_t status = __real_psa_import_key(attributes, data, data_length, key);

    if (status != PSA_ERROR_ALREADY_EXISTS ||
        PSA_KEY_LIFETIME_IS_VOLATILE(psa_get_key_lifetime(attributes))) {
        return status;
    }

    ESP_LOGW(TAG, "persistent key 0x%lx exists, replacing", (unsigned long)psa_get_key_id(attributes));
    if (psa_destroy_key(psa_get_key_id(attributes)) != PSA_SUCCESS) {
        return status;
    }
    return __real_psa_import_key(attributes, data, data_length, key);
}
