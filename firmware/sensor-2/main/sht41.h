#pragma once

#include "esp_err.h"

esp_err_t sht41_init(void);
esp_err_t sht41_read(float *temp_c, float *rh);
