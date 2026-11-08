#include "sht41.h"

#include "driver/i2c_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define SDA_GPIO   22
#define SCL_GPIO   23
#define SHT41_ADDR 0x44

static i2c_master_dev_handle_t s_dev;

static uint8_t sht_crc(const uint8_t *d)
{
    uint8_t crc = 0xFF;
    for (int i = 0; i < 2; i++) {
        crc ^= d[i];
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : (crc << 1);
        }
    }
    return crc;
}

esp_err_t sht41_init(void)
{
    i2c_master_bus_handle_t bus;
    i2c_master_bus_config_t bus_cfg = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = I2C_NUM_0,
        .sda_io_num = SDA_GPIO,
        .scl_io_num = SCL_GPIO,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &bus);
    if (err != ESP_OK) {
        return err;
    }

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = SHT41_ADDR,
        .scl_speed_hz = 100000,
    };
    return i2c_master_bus_add_device(bus, &dev_cfg, &s_dev);
}

esp_err_t sht41_read(float *temp_c, float *rh)
{
    uint8_t cmd = 0xFD; // high-precision measurement
    uint8_t buf[6];

    esp_err_t err = i2c_master_transmit(s_dev, &cmd, 1, 100);
    if (err != ESP_OK) {
        return err;
    }
    vTaskDelay(pdMS_TO_TICKS(10)); // max conversion ~8.3 ms

    err = i2c_master_receive(s_dev, buf, sizeof(buf), 100);
    if (err != ESP_OK) {
        return err;
    }
    if (sht_crc(&buf[0]) != buf[2] || sht_crc(&buf[3]) != buf[5]) {
        return ESP_ERR_INVALID_CRC;
    }

    uint16_t t_raw = (buf[0] << 8) | buf[1];
    uint16_t h_raw = (buf[3] << 8) | buf[4];
    *temp_c = -45.0f + 175.0f * t_raw / 65535.0f;
    float h = -6.0f + 125.0f * h_raw / 65535.0f;
    *rh = h < 0 ? 0 : (h > 100 ? 100 : h);
    return ESP_OK;
}
