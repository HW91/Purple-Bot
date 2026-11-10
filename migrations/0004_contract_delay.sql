-- Also save the Time Delay (seconds) a bot was using on each contract, so the chart's dotted delay line is exact per contract.
-- Contracts saved before this column existed have NULL and fall back to the bot's current setting on the chart.
ALTER TABLE contract_settings ADD COLUMN delay_sec INTEGER;
