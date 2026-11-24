CREATE TABLE `lotes_produccion_ediciones` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `lote_id` INT NOT NULL,
  `usuarios_id` INT NOT NULL,
  `numero_edicion` INT NOT NULL,
  `tipo_registro` VARCHAR(30) NOT NULL DEFAULT 'edicion',
  `estado` VARCHAR(30) NOT NULL DEFAULT 'vigente',
  `fecha` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `costo_total` DECIMAL(10,2) NULL DEFAULT 0.00,
  `notas` TEXT NULL,
  `productos_snapshot` JSON NOT NULL,
  `insumos_snapshot` JSON NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lote_numero_edicion` (`lote_id`, `numero_edicion`),
  KEY `idx_ediciones_lote_fecha` (`lote_id`, `fecha`),
  KEY `idx_ediciones_usuario` (`usuarios_id`),

  CONSTRAINT `fk_ediciones_lote`
    FOREIGN KEY (`lote_id`)
    REFERENCES `lotes_produccion` (`id`)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT `fk_ediciones_usuario`
    FOREIGN KEY (`usuarios_id`)
    REFERENCES `usuarios` (`id`)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

ALTER TABLE `movimientos_insumos`
  ADD COLUMN `edicion_id` INT NULL,
  ADD INDEX `idx_movinsumos_edicion` (`edicion_id`),
  ADD CONSTRAINT `fk_movinsumos_edicion`
    FOREIGN KEY (`edicion_id`)
    REFERENCES `lotes_produccion_ediciones` (`id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;