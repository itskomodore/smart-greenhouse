#include "analog_probe.h"

#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define PIN_HIGH   21
#define PIN_LOW    1
#define LIGHT_CH   ADC_CHANNEL_0 // GPIO0
#define SOIL_CH    ADC_CHANNEL_2 // GPIO2 (A2)
#define SETTLE_MS  100           // soil sensors need time after power-up
#define SAMPLES    16
#define ADC_MAX    4095          // 12-bit full scale

static esp_err_t read_avg(adc_oneshot_unit_handle_t adc, adc_channel_t ch, int *out)
{
    int sum = 0;
    for (int i = 0; i < SAMPLES; i++) {
        int v;
        esp_err_t err = adc_oneshot_read(adc, ch, &v);
        if (err != ESP_OK) {
            return err;
        }
        sum += v;
    }
    *out = sum / SAMPLES;
    return ESP_OK;
}

esp_err_t analog_probe_read(int *light_raw, int *soil_raw)
{
    gpio_config_t out_cfg = {
        .pin_bit_mask = (1ULL << PIN_HIGH) | (1ULL << PIN_LOW),
        .mode = GPIO_MODE_OUTPUT,
    };
    esp_err_t err = gpio_config(&out_cfg);
    if (err != ESP_OK) {
        return err;
    }
    gpio_set_level(PIN_HIGH, 1);
    gpio_set_level(PIN_LOW, 0);
    vTaskDelay(pdMS_TO_TICKS(SETTLE_MS));

    adc_oneshot_unit_handle_t adc;
    adc_oneshot_unit_init_cfg_t unit_cfg = { .unit_id = ADC_UNIT_1 };
    err = adc_oneshot_new_unit(&unit_cfg, &adc);
    if (err == ESP_OK) {
        adc_oneshot_chan_cfg_t ch_cfg = {
            .atten = ADC_ATTEN_DB_12,
            .bitwidth = ADC_BITWIDTH_DEFAULT,
        };
        err = adc_oneshot_config_channel(adc, LIGHT_CH, &ch_cfg);
        if (err == ESP_OK) {
            err = adc_oneshot_config_channel(adc, SOIL_CH, &ch_cfg);
        }
        if (err == ESP_OK) {
            err = read_avg(adc, LIGHT_CH, light_raw);
        }
        if (err == ESP_OK) {
            err = read_avg(adc, SOIL_CH, soil_raw);
        }
        if (err == ESP_OK) {
            // Both sensors read low when "more" (brighter / wetter): flip so higher = more.
            *light_raw = ADC_MAX - *light_raw;
            *soil_raw = ADC_MAX - *soil_raw;
        }
        adc_oneshot_del_unit(adc);
    }

    // Drop the drive pins so nothing burns power in deep sleep.
    gpio_reset_pin(PIN_HIGH);
    gpio_reset_pin(PIN_LOW);
    return err;
}
