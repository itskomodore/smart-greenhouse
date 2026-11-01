idf_component_register(SRCS "esp_ot_sleepy_device.c" "psa_import_recover.c"
                       PRIV_REQUIRES esp_event openthread nvs_flash mbedtls
                       INCLUDE_DIRS ".")

if(CONFIG_ESP_SLEEP_DEBUG)
    idf_component_optional_requires(PRIVATE esp_timer)
endif()

# psa_import_recover.c: replace psa_import_key so a half-moved OpenThread key set can recover.
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=psa_import_key" "-Wl,-u,__wrap_psa_import_key")
