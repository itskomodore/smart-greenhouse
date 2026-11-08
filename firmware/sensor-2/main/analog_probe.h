#pragma once

#include "esp_err.h"

// Drives GPIO21 high and GPIO1 low, reads ADC1_CH0 (GPIO0, light divider) and
// ADC1_CH2 (GPIO2, soil sensor) as 12-bit counts, then releases the drive pins.
// Values are inverted (4095 - raw) so that higher means brighter / wetter.
esp_err_t analog_probe_read(int *light_raw, int *soil_raw);
