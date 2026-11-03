import type { DatabaseSync } from "node:sqlite";

type RuleRow = {
  id?: unknown;
  life_area_id?: unknown;
  condition_type: unknown;
  condition_value: unknown;
  date_from: unknown;
  date_to: unknown;
  enabled?: unknown;
};

export function createLifeAreaStore(db: DatabaseSync) {
  function normalizeName(value: unknown): string {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name) throw new Error("Bitte einen Namen für den Lebensbereich eingeben.");
    if (name.length > 120) throw new Error("Der Name des Lebensbereichs ist zu lang.");
    return name;
  }

  function ruleLabel(row: RuleRow): string {
    const type = String(row.condition_type);
    const value =
      row.condition_value === null || row.condition_value === undefined
        ? ""
        : String(row.condition_value);

    if (type === "person") {
      const person = db.prepare("SELECT name FROM persons WHERE id=?").get(Number(value));
      return "Person: " + (person ? String(person.name) : "#" + value);
    }
    if (type === "pet") {
      const pet = db.prepare("SELECT name FROM pets WHERE id=?").get(Number(value));
      return "Haustier: " + (pet ? String(pet.name) : "#" + value);
    }
    if (type === "tag") return "Merkmal: " + value;
    if (type === "path") return "Pfad enthält: " + value;
    if (type === "date") {
      const from = row.date_from ? String(row.date_from) : "…";
      const to = row.date_to ? String(row.date_to) : "…";
      return "Zeitraum: " + from + " – " + to;
    }
    return type + ": " + value;
  }

  function list() {
    const areas = db.prepare(`
      SELECT
        la.id,
        la.name,
        COUNT(DISTINCT mla.media_id) AS media_count,
        COUNT(DISTINCT CASE WHEN mla.assignment_source='MANUAL' THEN mla.media_id END) AS manual_count,
        COUNT(DISTINCT lar.id) AS rule_count
      FROM life_areas la
      LEFT JOIN media_life_areas mla ON mla.life_area_id=la.id
      LEFT JOIN life_area_rules lar ON lar.life_area_id=la.id
      GROUP BY la.id, la.name
      ORDER BY la.name COLLATE NOCASE, la.id
    `).all();

    const ruleQuery = db.prepare(`
      SELECT
        lar.id,
        lar.life_area_id,
        lar.condition_type,
        lar.condition_value,
        lar.date_from,
        lar.date_to,
        lar.enabled,
        COUNT(DISTINCT mla.media_id) AS matched_media_count
      FROM life_area_rules lar
      LEFT JOIN media_life_areas mla
        ON mla.rule_id=lar.id
        AND mla.assignment_source='RULE'
      WHERE lar.life_area_id=?
      GROUP BY lar.id
      ORDER BY lar.id
    `);

    return areas.map((area) => ({
      id: Number(area.id),
      name: String(area.name),
      mediaCount: Number(area.media_count ?? 0),
      manualCount: Number(area.manual_count ?? 0),
      ruleCount: Number(area.rule_count ?? 0),
      rules: ruleQuery.all(Number(area.id)).map((rule) => ({
        id: Number(rule.id),
        lifeAreaId: Number(rule.life_area_id),
        conditionType: String(rule.condition_type),
        conditionValue:
          rule.condition_value === null || rule.condition_value === undefined
            ? null
            : String(rule.condition_value),
        dateFrom: rule.date_from ? String(rule.date_from) : null,
        dateTo: rule.date_to ? String(rule.date_to) : null,
        enabled: Boolean(rule.enabled),
        matchedMediaCount: Number(rule.matched_media_count ?? 0)
      }))
    }));
  }

  function create(rawName: unknown) {
    const name = normalizeName(rawName);
    const existing = db.prepare(
      "SELECT id,name FROM life_areas WHERE name=? COLLATE NOCASE"
    ).get(name);
    if (existing) {
      return { id: Number(existing.id), name: String(existing.name) };
    }

    const inserted = db.prepare("INSERT INTO life_areas(name) VALUES(?)").run(name);
    return { id: Number(inserted.lastInsertRowid), name };
  }

  function rename(lifeAreaId: number, rawName: unknown) {
    const name = normalizeName(rawName);
    if (!db.prepare("SELECT 1 FROM life_areas WHERE id=?").get(lifeAreaId)) {
      throw new Error("Der Lebensbereich wurde nicht gefunden.");
    }
    db.prepare(
      "UPDATE life_areas SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).run(name, lifeAreaId);
    return { changed: true as const };
  }

  function remove(lifeAreaId: number) {
    const result = db.prepare("DELETE FROM life_areas WHERE id=?").run(lifeAreaId);
    if (Number(result.changes) === 0) {
      throw new Error("Der Lebensbereich wurde nicht gefunden.");
    }
    return { changed: true as const };
  }

  function validateRule(
    conditionType: unknown,
    conditionValue: unknown,
    rawDateFrom: unknown,
    rawDateTo: unknown
  ) {
    const allowed = new Set(["person", "pet", "tag", "path", "date"]);
    const type = typeof conditionType === "string" ? conditionType.trim() : "";
    if (!allowed.has(type)) throw new Error("Regeltyp ist ungültig.");

    const value =
      typeof conditionValue === "string" && conditionValue.trim()
        ? conditionValue.trim()
        : conditionValue === null || conditionValue === undefined
          ? null
          : String(conditionValue).trim();

    const dateFrom =
      typeof rawDateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDateFrom)
        ? rawDateFrom
        : null;
    const dateTo =
      typeof rawDateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDateTo)
        ? rawDateTo
        : null;

    if (type === "person") {
      const id = Number(value);
      if (
        !Number.isInteger(id) ||
        !db.prepare("SELECT 1 FROM persons WHERE id=?").get(id)
      ) {
        throw new Error("Bitte eine bestätigte Person auswählen.");
      }
      return { type, value: String(id), dateFrom: null, dateTo: null };
    }

    if (type === "pet") {
      const id = Number(value);
      if (
        !Number.isInteger(id) ||
        !db.prepare("SELECT 1 FROM pets WHERE id=?").get(id)
      ) {
        throw new Error("Bitte ein bestätigtes Haustier auswählen.");
      }
      return { type, value: String(id), dateFrom: null, dateTo: null };
    }

    if (type === "date") {
      if (!dateFrom && !dateTo) {
        throw new Error("Für eine Zeitraumregel bitte mindestens ein Datum angeben.");
      }
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error("Das Enddatum liegt vor dem Startdatum.");
      }
      return { type, value: null, dateFrom, dateTo };
    }

    if (!value) {
      throw new Error(
        type === "path"
          ? "Bitte einen Pfadbestandteil eingeben."
          : "Bitte ein Merkmal eingeben."
      );
    }
    if (value.length > 300) throw new Error("Der Regelwert ist zu lang.");

    return { type, value, dateFrom: null, dateTo: null };
  }

  function mediaIdsForRule(rule: RuleRow): number[] {
    const type = String(rule.condition_type);
    const value =
      rule.condition_value === null || rule.condition_value === undefined
        ? null
        : String(rule.condition_value);

    const base = `
      SELECT DISTINCT m.id
      FROM media_items m
      JOIN media_sources ms ON ms.id=m.source_id
      LEFT JOIN media_image_metadata md
        ON md.media_id=m.id AND md.input_sha256=m.sha256
      WHERE ms.enabled=1
        AND m.availability='AVAILABLE'
    `;

    if (type === "person") {
      const personId = Number(value);
      return db.prepare(base + `
        AND (
          EXISTS (
            SELECT 1
            FROM person_face_assignments pfa
            JOIN face_detections fd ON fd.id=pfa.face_detection_id
            WHERE pfa.person_id=?
              AND fd.media_id=m.id
              AND fd.input_sha256=m.sha256
          )
          OR EXISTS (
            SELECT 1
            FROM video_identity_tracks vit
            WHERE vit.media_id=m.id
              AND vit.identity_kind='person'
              AND vit.identity_id=?
          )
        )
      `).all(personId, personId).map((row) => Number(row.id));
    }

    if (type === "pet") {
      const petId = Number(value);
      return db.prepare(base + `
        AND (
          EXISTS (
            SELECT 1
            FROM pet_assignments pa
            JOIN pet_fused_detections pd ON pd.id=pa.pet_detection_id
            WHERE pa.pet_id=?
              AND pd.media_id=m.id
              AND pd.input_sha256=m.sha256
          )
          OR EXISTS (
            SELECT 1
            FROM video_identity_tracks vit
            WHERE vit.media_id=m.id
              AND vit.identity_kind='pet'
              AND vit.identity_id=?
          )
        )
      `).all(petId, petId).map((row) => Number(row.id));
    }

    if (type === "tag") {
      const needle = "%" + String(value ?? "").toLocaleLowerCase("de-DE") + "%";
      return db.prepare(base + `
        AND (
          EXISTS (
            SELECT 1
            FROM object_fused_detections od
            WHERE od.media_id=m.id
              AND od.input_sha256=m.sha256
              AND lower(od.label) LIKE ?
          )
          OR EXISTS (
            SELECT 1
            FROM video_tags vt
            WHERE vt.media_id=m.id
              AND lower(vt.label) LIKE ?
          )
          OR EXISTS (
            SELECT 1
            FROM media_semantic_annotations msa
            WHERE msa.media_id=m.id
              AND msa.input_sha256=m.sha256
              AND (
                lower(msa.description) LIKE ?
                OR lower(msa.subjects_json) LIKE ?
                OR lower(msa.actions_json) LIKE ?
                OR lower(msa.scenes_json) LIKE ?
                OR lower(msa.tags_json) LIKE ?
                OR lower(msa.concepts_json) LIKE ?
              )
          )
        )
      `).all(
        needle,
        needle,
        needle,
        needle,
        needle,
        needle,
        needle,
        needle
      ).map((row) => Number(row.id));
    }

    if (type === "path") {
      const needle = "%" + String(value ?? "").toLocaleLowerCase("de-DE") + "%";
      return db.prepare(base + " AND lower(m.relative_path) LIKE ?")
        .all(needle)
        .map((row) => Number(row.id));
    }

    const dateFrom = rule.date_from ? String(rule.date_from) : null;
    const dateTo = rule.date_to ? String(rule.date_to) : null;
    const clauses: string[] = [];
    const args: string[] = [];
    const mediaDate =
      "date(COALESCE(md.captured_at, datetime(m.mtime_ms/1000,'unixepoch')))";
    if (dateFrom) {
      clauses.push(mediaDate + " >= ?");
      args.push(dateFrom);
    }
    if (dateTo) {
      clauses.push(mediaDate + " <= ?");
      args.push(dateTo);
    }
    if (clauses.length === 0) return [];

    return db.prepare(base + " AND " + clauses.join(" AND "))
      .all(...args)
      .map((row) => Number(row.id));
  }

  function applyRules(requestedLifeAreaId?: number) {
    const areaIds = requestedLifeAreaId === undefined
      ? db.prepare("SELECT id FROM life_areas ORDER BY id")
          .all()
          .map((row) => Number(row.id))
      : [requestedLifeAreaId];

    const insertAssignment = db.prepare(`
      INSERT INTO media_life_areas(
        media_id,life_area_id,assignment_source,rule_id,updated_at
      )
      SELECT ?,?,'RULE',?,CURRENT_TIMESTAMP
      WHERE NOT EXISTS (
        SELECT 1
        FROM life_area_exclusions e
        WHERE e.media_id=?
          AND e.life_area_id=?
      )
      ON CONFLICT(media_id,life_area_id) DO NOTHING
    `);

    let assigned = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const areaId of areaIds) {
        const area = db.prepare("SELECT id FROM life_areas WHERE id=?").get(areaId);
        if (!area) {
          if (requestedLifeAreaId !== undefined) {
            throw new Error("Der Lebensbereich wurde nicht gefunden.");
          }
          continue;
        }

        db.prepare(`
          DELETE FROM media_life_areas
          WHERE life_area_id=?
            AND assignment_source='RULE'
        `).run(areaId);

        const rules = db.prepare(`
          SELECT id,condition_type,condition_value,date_from,date_to
          FROM life_area_rules
          WHERE life_area_id=?
            AND enabled=1
          ORDER BY id
        `).all(areaId);

        for (const rule of rules) {
          const mediaIds = mediaIdsForRule(rule as RuleRow);
          for (const mediaId of mediaIds) {
            assigned += Number(
              insertAssignment.run(
                mediaId,
                areaId,
                Number(rule.id),
                mediaId,
                areaId
              ).changes
            );
          }
        }
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return { assigned, areas: areaIds.length };
  }

  function addRule(
    lifeAreaId: number,
    conditionType: unknown,
    conditionValue: unknown,
    dateFrom: unknown,
    dateTo: unknown
  ) {
    if (!db.prepare("SELECT 1 FROM life_areas WHERE id=?").get(lifeAreaId)) {
      throw new Error("Der Lebensbereich wurde nicht gefunden.");
    }

    const validated = validateRule(
      conditionType,
      conditionValue,
      dateFrom,
      dateTo
    );
    const inserted = db.prepare(`
      INSERT INTO life_area_rules(
        life_area_id,condition_type,condition_value,date_from,date_to,enabled
      )
      VALUES(?,?,?,?,?,1)
    `).run(
      lifeAreaId,
      validated.type,
      validated.value,
      validated.dateFrom,
      validated.dateTo
    );

    applyRules(lifeAreaId);
    return { id: Number(inserted.lastInsertRowid) };
  }

  function deleteRule(ruleId: number) {
    const rule = db.prepare(
      "SELECT id,life_area_id FROM life_area_rules WHERE id=?"
    ).get(ruleId);
    if (!rule) throw new Error("Die Lebensbereich-Regel wurde nicht gefunden.");

    db.prepare(
      "DELETE FROM media_life_areas WHERE rule_id=? AND assignment_source='RULE'"
    ).run(ruleId);
    db.prepare("DELETE FROM life_area_rules WHERE id=?").run(ruleId);
    applyRules(Number(rule.life_area_id));
    return { changed: true as const };
  }

  function setRuleEnabled(ruleId: number, enabled: unknown) {
    const rule = db.prepare(
      "SELECT id,life_area_id FROM life_area_rules WHERE id=?"
    ).get(ruleId);
    if (!rule) throw new Error("Die Lebensbereich-Regel wurde nicht gefunden.");

    db.prepare(`
      UPDATE life_area_rules
      SET enabled=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(Boolean(enabled) ? 1 : 0, ruleId);

    applyRules(Number(rule.life_area_id));
    return { changed: true as const };
  }

  function setMedia(
    mediaId: number,
    lifeAreaId: number,
    assigned: unknown
  ) {
    if (!db.prepare("SELECT 1 FROM media_items WHERE id=?").get(mediaId)) {
      throw new Error("Das Medium wurde nicht gefunden.");
    }
    if (!db.prepare("SELECT 1 FROM life_areas WHERE id=?").get(lifeAreaId)) {
      throw new Error("Der Lebensbereich wurde nicht gefunden.");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      if (Boolean(assigned)) {
        db.prepare(
          "DELETE FROM life_area_exclusions WHERE media_id=? AND life_area_id=?"
        ).run(mediaId, lifeAreaId);
        db.prepare(`
          INSERT INTO media_life_areas(
            media_id,life_area_id,assignment_source,rule_id,updated_at
          )
          VALUES(?,?,'MANUAL',NULL,CURRENT_TIMESTAMP)
          ON CONFLICT(media_id,life_area_id) DO UPDATE SET
            assignment_source='MANUAL',
            rule_id=NULL,
            updated_at=CURRENT_TIMESTAMP
        `).run(mediaId, lifeAreaId);
      } else {
        db.prepare(
          "DELETE FROM media_life_areas WHERE media_id=? AND life_area_id=?"
        ).run(mediaId, lifeAreaId);
        db.prepare(`
          INSERT INTO life_area_exclusions(media_id,life_area_id,reason)
          VALUES(?,?,'MANUAL_REMOVE')
          ON CONFLICT(media_id,life_area_id) DO UPDATE SET
            reason='MANUAL_REMOVE'
        `).run(mediaId, lifeAreaId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return { changed: true as const };
  }

  function listMedia(lifeAreaId: number) {
    if (!db.prepare("SELECT 1 FROM life_areas WHERE id=?").get(lifeAreaId)) {
      throw new Error("Der Lebensbereich wurde nicht gefunden.");
    }

    return db.prepare(`
      SELECT
        m.id AS media_id,
        m.source_id,
        m.relative_path,
        m.extension,
        m.mtime_ms,
        md.captured_at,
        md.gps_latitude,
        md.gps_longitude,
        CASE
          WHEN t.media_id IS NOT NULL AND t.input_sha256=m.sha256
          THEN t.input_sha256
          ELSE NULL
        END AS thumbnail_version,
        mla.assignment_source,
        mla.rule_id,
        lar.condition_type,
        lar.condition_value,
        lar.date_from,
        lar.date_to
      FROM media_life_areas mla
      JOIN media_items m ON m.id=mla.media_id
      JOIN media_sources ms ON ms.id=m.source_id
      LEFT JOIN media_image_metadata md
        ON md.media_id=m.id AND md.input_sha256=m.sha256
      LEFT JOIN media_thumbnails t ON t.media_id=m.id
      LEFT JOIN life_area_rules lar ON lar.id=mla.rule_id
      WHERE mla.life_area_id=?
        AND ms.enabled=1
        AND m.availability='AVAILABLE'
      ORDER BY COALESCE(
        md.captured_at,
        datetime(m.mtime_ms/1000,'unixepoch')
      ) DESC, m.id DESC
      LIMIT 10000
    `).all(lifeAreaId).map((row) => ({
      mediaId: Number(row.media_id),
      sourceId: Number(row.source_id),
      relativePath: String(row.relative_path),
      extension: String(row.extension),
      capturedAt: row.captured_at ? String(row.captured_at) : null,
      mtimeMs: Number(row.mtime_ms),
      thumbnailVersion: row.thumbnail_version ? String(row.thumbnail_version) : null,
      latitude:
        row.gps_latitude === null || row.gps_latitude === undefined
          ? null
          : Number(row.gps_latitude),
      longitude:
        row.gps_longitude === null || row.gps_longitude === undefined
          ? null
          : Number(row.gps_longitude),
      assignmentSource:
        String(row.assignment_source) === "MANUAL" ? "MANUAL" : "RULE",
      ruleId: row.rule_id === null ? null : Number(row.rule_id),
      ruleLabel:
        row.rule_id === null
          ? null
          : ruleLabel({
              condition_type: row.condition_type,
              condition_value: row.condition_value,
              date_from: row.date_from,
              date_to: row.date_to
            })
    }));
  }

  function assignmentsForMedia(mediaId: number) {
    return db.prepare(`
      SELECT
        la.id AS life_area_id,
        la.name,
        mla.assignment_source,
        mla.rule_id,
        lar.condition_type,
        lar.condition_value,
        lar.date_from,
        lar.date_to
      FROM media_life_areas mla
      JOIN life_areas la ON la.id=mla.life_area_id
      LEFT JOIN life_area_rules lar ON lar.id=mla.rule_id
      WHERE mla.media_id=?
      ORDER BY la.name COLLATE NOCASE, la.id
    `).all(mediaId).map((row) => ({
      lifeAreaId: Number(row.life_area_id),
      name: String(row.name),
      assignmentSource:
        String(row.assignment_source) === "MANUAL" ? "MANUAL" : "RULE",
      ruleId: row.rule_id === null ? null : Number(row.rule_id),
      ruleLabel:
        row.rule_id === null
          ? null
          : ruleLabel({
              condition_type: row.condition_type,
              condition_value: row.condition_value,
              date_from: row.date_from,
              date_to: row.date_to
            })
    }));
  }

  function reset() {
    db.exec(`
      DELETE FROM life_area_exclusions;
      DELETE FROM media_life_areas;
      DELETE FROM life_area_rules;
      DELETE FROM life_areas;
    `);
  }

  return {
    list,
    create,
    rename,
    remove,
    addRule,
    deleteRule,
    setRuleEnabled,
    applyRules,
    listMedia,
    setMedia,
    assignmentsForMedia,
    reset
  };
}
