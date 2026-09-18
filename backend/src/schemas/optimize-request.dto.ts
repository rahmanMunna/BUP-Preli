import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Request contract of `POST /optimize-energy`.
 *
 * Field aliases the judge might use (`demand`, `hourly`, `tariff`, ...) are
 * rewritten to these canonical names by `NormalizeBodyMiddleware`, so this DTO
 * only has to describe the canonical shape. Optional fields are defaulted in
 * `OptimizeService` rather than here, for the same reason: class-transformer
 * does not visit keys that are absent from the payload.
 */
export class HourInputDto {
  @IsInt({ message: 'hours.hour must be an integer hour index' })
  @Min(0)
  @Max(23)
  hour: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  demand_kwh: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  solar_kwh?: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  tariff_bdt_per_kwh: number;
}

export class BatteryInputDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  capacity_kwh: number;

  /** State of charge at the start of the first hour. Defaults to 0. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  initial_soc_kwh?: number;

  /** Maximum energy pushed into the battery within one hour. Defaults to capacity. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  max_charge_kwh?: number;

  /** Maximum energy pulled out of the battery within one hour. Defaults to capacity. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  max_discharge_kwh?: number;

  /** Charging efficiency in (0,1]; stored energy = drawn energy * efficiency. Defaults to 0.95. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(1)
  efficiency?: number;

  /** Floor the state of charge must respect across the horizon. Defaults to 0. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  min_reserve_kwh?: number;
}

export class OptimizeEnergyRequestDto {
  @IsString()
  @MaxLength(200)
  scenario_id: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({
    each: true,
    message: 'operator_notes must be an array of strings',
  })
  @MaxLength(2000, { each: true })
  operator_notes?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => HourInputDto)
  hours: HourInputDto[];

  @ValidateNested()
  @Type(() => BatteryInputDto)
  battery: BatteryInputDto;
}
