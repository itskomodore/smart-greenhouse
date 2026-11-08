/*
 * SPDX-FileCopyrightText: 2023-2025 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: CC0-1.0
 *
 * OpenThread Command Line Example
 *
 * This example code is in the Public Domain (or CC0 licensed, at your option.)
 *
 * Unless required by applicable law or agreed to in writing, this
 * software is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied.
*/

#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <string.h>
#include <sys/time.h>
#include "esp_err.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "esp_openthread.h"
#include "esp_openthread_netif_glue.h"
#include "esp_ot_sleepy_device_config.h"
#include "esp_vfs_eventfd.h"
#include "nvs_flash.h"
#include "driver/rtc_io.h"
#include "driver/gpio.h"
#include "openthread/coap.h"
#include "openthread/ip6.h"
#include "openthread/error.h"
#include "openthread/message.h"
#include "openthread/thread.h"
#include "sht41.h"
#include "analog_probe.h"

#if !SOC_IEEE802154_SUPPORTED
#error "Openthread sleepy device is only supported for the SoCs which have IEEE 802.15.4 module"
#endif

#define TAG "ot_esp_power_save"

static RTC_DATA_ATTR struct timeval s_sleep_enter_time;

static void create_config_network(otInstance *instance)
{
    otLinkModeConfig linkMode = { 0 };

    linkMode.mRxOnWhenIdle = false;
    linkMode.mDeviceType = false;
    linkMode.mNetworkData = false;

    if (otLinkSetPollPeriod(instance, CONFIG_OPENTHREAD_NETWORK_POLLPERIOD_TIME) != OT_ERROR_NONE) {
        ESP_LOGE(TAG, "Failed to set OpenThread pollperiod.");
        abort();
    }

    if (otThreadSetLinkMode(instance, linkMode) != OT_ERROR_NONE) {
        ESP_LOGE(TAG, "Failed to set OpenThread linkmode.");
        abort();
    }
    ESP_ERROR_CHECK(esp_openthread_auto_start(NULL));
}

static float s_temp_c, s_rh;
static esp_err_t s_sht_err = ESP_ERR_INVALID_STATE;
static int s_light_raw, s_soil_raw;
static esp_err_t s_adc_err = ESP_ERR_INVALID_STATE;

static void report_sht41(void)
{
    if (s_sht_err == ESP_OK) {
        ESP_LOGI(TAG, "SHT41: %.2f C, %.2f %%RH", s_temp_c, s_rh);
    } else {
        ESP_LOGE(TAG, "SHT41 read failed: %s", esp_err_to_name(s_sht_err));
    }
    if (s_adc_err == ESP_OK) {
        ESP_LOGI(TAG, "light raw=%d, soil raw=%d", s_light_raw, s_soil_raw);
    } else {
        ESP_LOGE(TAG, "ADC read failed: %s", esp_err_to_name(s_adc_err));
    }
}

static void enter_deep_sleep(void)
{
    ESP_LOGI(TAG, "Enter deep sleep");
    fflush(stdout);
    gettimeofday(&s_sleep_enter_time, NULL);
    esp_deep_sleep_start();
}

static void coap_response_cb(void *ctx, otMessage *msg, const otMessageInfo *info, otError result)
{
    OT_UNUSED_VARIABLE(ctx);
    OT_UNUSED_VARIABLE(msg);
    OT_UNUSED_VARIABLE(info);
    if (result == OT_ERROR_NONE) {
        ESP_LOGI(TAG, "CoAP report acknowledged");
    } else {
        ESP_LOGW(TAG, "CoAP report failed: %s", otThreadErrorToString(result));
    }
    enter_deep_sleep();
}

static int json_field(char *buf, size_t size, const char *key, bool ok, double val, int prec)
{
    if (ok) {
        return snprintf(buf, size, "\"%s\":%.*f", key, prec, val);
    }
    return snprintf(buf, size, "\"%s\":null", key);
}

// Sends the readings as JSON in a confirmable CoAP POST to /sensor, then
// sleeps from the response callback. Falls back to sleeping on any send error.
static void send_report(otInstance *instance)
{
    char t[24], rh[24], light[24], soil[24], payload[128];
    json_field(t, sizeof(t), "t", s_sht_err == ESP_OK, s_temp_c, 2);
    json_field(rh, sizeof(rh), "rh", s_sht_err == ESP_OK, s_rh, 2);
    json_field(light, sizeof(light), "light", s_adc_err == ESP_OK, s_light_raw, 0);
    json_field(soil, sizeof(soil), "soil", s_adc_err == ESP_OK, s_soil_raw, 0);
    int len = snprintf(payload, sizeof(payload), "{%s,%s,%s,%s}", t, rh, light, soil);
    if (len <= 0 || len >= (int)sizeof(payload)) {
        ESP_LOGE(TAG, "JSON payload error");
        enter_deep_sleep();
        return;
    }

    otMessageInfo info;
    memset(&info, 0, sizeof(info));
    if (otIp6AddressFromString(CONFIG_REPORT_DEST_ADDR, &info.mPeerAddr) != OT_ERROR_NONE) {
        ESP_LOGE(TAG, "Bad CONFIG_REPORT_DEST_ADDR: %s", CONFIG_REPORT_DEST_ADDR);
        enter_deep_sleep();
        return;
    }
    info.mPeerPort = OT_DEFAULT_COAP_PORT;

    otError err = otCoapStart(instance, OT_DEFAULT_COAP_PORT);
    otMessage *msg = (err == OT_ERROR_NONE) ? otCoapNewMessage(instance, NULL) : NULL;
    if (msg) {
        otCoapMessageInit(msg, OT_COAP_TYPE_CONFIRMABLE, OT_COAP_CODE_POST);
        otCoapMessageGenerateToken(msg, OT_COAP_DEFAULT_TOKEN_LENGTH);
        err = otCoapMessageAppendUriPathOptions(msg, "sensor");
        if (err == OT_ERROR_NONE) {
            err = otCoapMessageAppendContentFormatOption(msg, OT_COAP_OPTION_CONTENT_FORMAT_JSON);
        }
        if (err == OT_ERROR_NONE) {
            err = otCoapMessageSetPayloadMarker(msg);
        }
        if (err == OT_ERROR_NONE) {
            err = otMessageAppend(msg, payload, len);
        }
        if (err == OT_ERROR_NONE) {
            // Short retry budget so a missing receiver does not keep us awake for long.
            otCoapTxParameters params = {
                .mAckTimeout = 1500,
                .mAckRandomFactorNumerator = 3,
                .mAckRandomFactorDenominator = 2,
                .mMaxRetransmit = 1,
            };
            err = otCoapSendRequestWithParameters(instance, msg, &info, coap_response_cb, NULL, &params);
        }
        if (err != OT_ERROR_NONE) {
            otMessageFree(msg);
        }
    } else if (err == OT_ERROR_NONE) {
        err = OT_ERROR_NO_BUFS;
    }

    if (err != OT_ERROR_NONE) {
        ESP_LOGE(TAG, "CoAP send failed: %s", otThreadErrorToString(err));
        enter_deep_sleep();
        return;
    }
    ESP_LOGI(TAG, "CoAP report sent: %s", payload);
}

static void ot_state_change_callback(otChangedFlags changed_flags, void* ctx)
{
    OT_UNUSED_VARIABLE(ctx);
    static otDeviceRole s_previous_role = OT_DEVICE_ROLE_DISABLED;
    otInstance* instance = esp_openthread_get_instance();
    if (!instance) {
        return;
    }
    otDeviceRole role = otThreadGetDeviceRole(instance);
    if (role == OT_DEVICE_ROLE_CHILD && s_previous_role != OT_DEVICE_ROLE_CHILD) {
        report_sht41();
        send_report(instance);
    }
    s_previous_role = role;
}

// GPIO15 is active-low: drive low on wake. Nothing is done before sleep;
// the pad floats in deep sleep (no hold).
#define STATUS_GPIO 15

static void status_gpio_on(void)
{
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << STATUS_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));
    gpio_set_level(STATUS_GPIO, 0);
}

static void ot_deep_sleep_init(void)
{
    // Within this function, we print the reason for the wake-up and configure the method of waking up from deep sleep.
    // This example provides support for two wake-up sources from deep sleep: RTC timer and GPIO.

    // The device enters deep sleep as soon as it becomes a CHILD (see ot_state_change_callback).

    // Print the wake-up reason:
    struct timeval now;
    gettimeofday(&now, NULL);
    int sleep_time_ms = (now.tv_sec - s_sleep_enter_time.tv_sec) * 1000 + (now.tv_usec - s_sleep_enter_time.tv_usec) / 1000;

    uint32_t wake_up_causes = esp_sleep_get_wakeup_causes();
    if (wake_up_causes & BIT(ESP_SLEEP_WAKEUP_UNDEFINED)) {
        ESP_LOGI(TAG, "Not a deep sleep reset");
    } else {
        if(wake_up_causes & BIT(ESP_SLEEP_WAKEUP_TIMER)) {
            ESP_LOGI(TAG, "Wake up from timer. Time spent in deep sleep and boot: %dms", sleep_time_ms);
        }
        if(wake_up_causes & BIT(ESP_SLEEP_WAKEUP_EXT1)) {
            ESP_LOGI(TAG, "Wake up from GPIO. Time spent in deep sleep and boot: %dms", sleep_time_ms);
        }
    }

    // Set the methods of how to wake up:
    // 1. RTC timer waking-up
    const int wakeup_time_sec = 20;
    ESP_LOGI(TAG, "Enabling timer wakeup, %ds\n", wakeup_time_sec);
    ESP_ERROR_CHECK(esp_sleep_enable_timer_wakeup(wakeup_time_sec * 1000000));

    // 2. GPIO waking-up
#if CONFIG_IDF_TARGET_ESP32C6
    // For ESP32C6 boards, RTCIO only supports GPIO0~GPIO7
    // GPIO7 pull down to wake up
    const int gpio_wakeup_pin = 7;
#elif CONFIG_IDF_TARGET_ESP32H2
    // You can wake up by pulling down GPIO9. On ESP32H2 development boards, the BOOT button is connected to GPIO9.
    // You can use the BOOT button to wake up the boards directly.
    const int gpio_wakeup_pin = 9;
#endif
    const uint64_t gpio_wakeup_pin_mask = 1ULL << gpio_wakeup_pin;
    // The configuration mode depends on your hardware design.
    // Since the BOOT button is connected to a pull-up resistor, the wake-up mode is configured as LOW.
    const uint64_t ext_wakeup_mode = 0;
    ESP_ERROR_CHECK(esp_sleep_enable_ext1_wakeup_io(gpio_wakeup_pin_mask, ext_wakeup_mode));

    // Also these two GPIO configurations are also depended on the hardware design.
    // The BOOT button is connected to the pull-up resistor, so enable the pull-up mode and disable the pull-down mode.

    // Notice: if these GPIO configurations do not match the hardware design, the deep sleep module will enable the GPIO hold
    // feature to hold the GPIO voltage when enter the sleep, which will ensure the board be waked up by GPIO. But it will cause
    // 3~4 times power consumption increasing during sleep.
    ESP_ERROR_CHECK(gpio_pullup_en(gpio_wakeup_pin));
    ESP_ERROR_CHECK(gpio_pulldown_dis(gpio_wakeup_pin));
}

void app_main(void)
{
    // Used eventfds:
    // * netif
    // * ot task queue
    // * radio driver
    esp_vfs_eventfd_config_t eventfd_config = {
        .max_fds = 3,
    };

    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_vfs_eventfd_register(&eventfd_config));
    ot_deep_sleep_init();
    status_gpio_on();

    // Read now, report later: USB serial is not up yet this early in boot.
    ESP_ERROR_CHECK(sht41_init());
    s_sht_err = sht41_read(&s_temp_c, &s_rh);
    s_adc_err = analog_probe_read(&s_light_raw, &s_soil_raw);

    static esp_openthread_config_t config = {
        .netif_config = ESP_NETIF_DEFAULT_OPENTHREAD(),
        .platform_config = {
            .radio_config = ESP_OPENTHREAD_DEFAULT_RADIO_CONFIG(),
            .host_config = ESP_OPENTHREAD_DEFAULT_HOST_CONFIG(),
            .port_config = ESP_OPENTHREAD_DEFAULT_PORT_CONFIG(),
        },
    };
    ESP_ERROR_CHECK(esp_openthread_start(&config));
    esp_netif_set_default_netif(esp_openthread_get_netif());

    otSetStateChangedCallback(esp_openthread_get_instance(), ot_state_change_callback, NULL);
    create_config_network(esp_openthread_get_instance());
}
