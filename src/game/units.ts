/**
 * The scale of the game. One turn is a minute of sailing; a boat at one knot covers 0.8 cells in it,
 * so a cell is about 39 m, roughly three lengths of the 40-foot boat.
 */
export const TURN_SECONDS = 60
export const CELLS_PER_KNOT = 0.8
export const METERS_PER_KNOT_MINUTE = 1852 / 60
export const CELL_METERS = METERS_PER_KNOT_MINUTE / CELLS_PER_KNOT
export const BOAT_LENGTH_METERS = 12.2
