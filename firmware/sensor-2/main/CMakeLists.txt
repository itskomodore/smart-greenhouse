idf_component_register(SRCS "esp_ot_sleepy_device.c" "sht41.c" "analog_probe.c"
                       PRIV_REQUIRES esp_event esp_timer openthread nvs_flash esp_driver_i2c esp_driver_gpio esp_adc
                       INCLUDE_DIRS ".")
