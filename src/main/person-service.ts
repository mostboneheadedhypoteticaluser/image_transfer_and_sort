import type {
  AnalysisQueueStats,
  CatalogStats,
  ConfirmPersonResult,
  FaceEmbeddingSet,
  MergePersonsResult,
  PersonCorrectionResult,
  PersonCandidate,
  PersonClusterInput,
  PersonOverview,
  PersonRecord
} from "../shared/protocol";
import { AnalysisService } from "./analysis-service";
import { CatalogService } from "./catalog-service";

const ALGORITHM_VERSION = "person-complete-link-v4";

type ClusterWorkerResult = {
  algorithm: string;
  clusterThreshold: number;
  verificationThreshold: number;
  minClusterSize: number;
  clusterCount: number;
  ungroupedCount: number;
  clusters: PersonClusterInput[];
};

type ReplacePersonCandidatesResult = {
  writtenClusters: number;
  writtenFaces: number;
};

export class PersonService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly analysis: AnalysisService
  ) {}

  async getOverview(
    sourceId: number,
    forceRefresh = false,
    allowWhilePending = false,
    rebuildIfNeeded = true
  ): Promise<PersonOverview> {
    const queue = await this.catalog.request<AnalysisQueueStats>(
      "getAnalysisQueueStats",
      {
        sourceId,
        module: "face-embed-sface-v1"
      }
    );

    const clusteringPending = queue.pending > 0 || queue.running > 0;

    if (
      (!clusteringPending || allowWhilePending) &&
      this.analysis.getStatus().state === "READY"
    ) {
      const set = await this.catalog.request<FaceEmbeddingSet>(
        "getFaceEmbeddingsForClustering",
        {
          sourceId,
          algorithmVersion: ALGORITHM_VERSION
        }
      );

      if (
        forceRefresh ||
        set.algorithmChanged ||
        (rebuildIfNeeded && set.needsRebuild)
      ) {
        const clustered = await this.analysis.request<ClusterWorkerResult>(
          "cluster_face_embeddings",
          {
            faces: set.faces,
            cannotLinks: set.cannotLinks,
            clusterThreshold: 0.62,
            verificationThreshold: 0.55,
            minClusterSize: 2
          },
          120000
        );

        const replaced =
          await this.catalog.request<ReplacePersonCandidatesResult>(
            "replacePersonCandidates",
            {
              sourceId,
              revision: set.revision,
              algorithmVersion: ALGORITHM_VERSION,
              clusters: clustered.clusters
            }
          );

        this.analysis.logDiagnostic("IDENTITY_CLUSTER_RESULT", {
          identity: "people",
          sourceId,
          inputEmbeddings: set.faces.length,
          workerClusters: clustered.clusterCount,
          writtenClusters: replaced.writtenClusters,
          writtenItems: replaced.writtenFaces,
          ungroupedItems: clustered.ungroupedCount
        });

        const expectedGroupedFaces = clustered.clusters.reduce(
          (sum, cluster) => sum + cluster.members.length,
          0
        );
        if (replaced.writtenFaces !== expectedGroupedFaces) {
          throw new Error(
            "Personengruppierung wollte " +
            expectedGroupedFaces +
            " Gesichter in echten Gruppen speichern, aber " +
            replaced.writtenFaces +
            " wurden geschrieben."
          );
        }
      }
    }

    const [candidates, persons, stats] = await Promise.all([
      this.catalog.request<PersonCandidate[]>("listPersonCandidates", {
        sourceId,
        // 500 größte Gruppen reichen für die Bestätigungsansicht; Einzelgesichter
        // werden grundsätzlich nicht als Gruppe gespeichert.
        limit: 500
      }),
      this.catalog.request<PersonRecord[]>("listPersons", { sourceId }),
      this.catalog.request<CatalogStats>("getStats", { sourceId })
    ]);

    return {
      candidates,
      persons,
      clusteringPending,
      candidateTotal: stats.personCandidates,
      candidateFaceTotal: stats.personCandidateFaces,
      ungroupedFaceTotal: Math.max(
        0,
        stats.unassignedFaceEmbeddings - stats.personCandidateFaces
      )
    };
  }

  async getCombinedOverview(forceRefresh = false): Promise<PersonOverview> {
    const sources = await this.catalog.request<Array<{
      id: number;
      path: string;
      enabled: boolean;
    }>>("listSources");
    const enabledSources = sources.filter((source) => source.enabled);

    const overviews: PersonOverview[] = [];
    for (const source of enabledSources) {
      // Normales Öffnen der Bestätigungsansicht ist read-only und darf nicht
      // spontan ein minutenlanges Re-Clustering auslösen. Ein explizites
      // Aktualisieren darf dagegen neu gruppieren.
      overviews.push(
        await this.getOverview(source.id, forceRefresh, false, forceRefresh)
      );
    }

    const personMap = new Map<number, PersonRecord>();
    for (const overview of overviews) {
      for (const person of overview.persons) {
        const existing = personMap.get(person.id);
        if (!existing) {
          personMap.set(person.id, {
            ...person,
            faces: [...person.faces]
          });
          continue;
        }

        existing.faceCount += person.faceCount;
        if (existing.representativeFaceId === null) {
          existing.representativeFaceId = person.representativeFaceId;
        }

        const knownFaceIds = new Set(
          existing.faces.map((face) => face.faceDetectionId)
        );
        for (const face of person.faces) {
          if (!knownFaceIds.has(face.faceDetectionId)) {
            existing.faces.push(face);
            knownFaceIds.add(face.faceDetectionId);
          }
        }
      }
    }

    const candidates = overviews
      .flatMap((overview) => overview.candidates)
      .sort(
        (a, b) =>
          b.faceCount - a.faceCount ||
          b.averageSimilarity - a.averageSimilarity ||
          b.newestFaceId - a.newestFaceId
      )
      .slice(0, 500);

    return {
      candidates,
      persons: [...personMap.values()].sort(
        (a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" })
      ),
      clusteringPending: overviews.some((overview) => overview.clusteringPending),
      candidateTotal: overviews.reduce(
        (sum, overview) => sum + overview.candidateTotal,
        0
      ),
      candidateFaceTotal: overviews.reduce(
        (sum, overview) => sum + overview.candidateFaceTotal,
        0
      ),
      ungroupedFaceTotal: overviews.reduce(
        (sum, overview) => sum + overview.ungroupedFaceTotal,
        0
      )
    };
  }

  async refreshAllSources(incremental = false): Promise<void> {
    const sources = await this.catalog.request<Array<{
      id: number;
      path: string;
      enabled: boolean;
    }>>("listSources");

    for (const source of sources) {
      if (!source.enabled) continue;
      await this.getOverview(source.id, incremental, incremental);
    }
  }

  async confirmCandidate(
    candidateId: number,
    name: string,
    fallbackFaceDetectionId?: number,
    expectedFaceCount?: number
  ): Promise<ConfirmPersonResult> {
    return this.catalog.request<ConfirmPersonResult>(
      "confirmPersonCandidate",
      { candidateId, name, fallbackFaceDetectionId, expectedFaceCount }
    );
  }

  async removeCandidateFace(
    candidateId: number,
    faceDetectionId: number
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "removeFaceFromPersonCandidate",
      { candidateId, faceDetectionId }
    );
  }

  async removePersonFace(
    personId: number,
    faceDetectionId: number
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "removeFaceFromPerson",
      { personId, faceDetectionId }
    );
  }

  async mergePersons(
    targetPersonId: number,
    sourcePersonId: number
  ): Promise<MergePersonsResult> {
    return this.catalog.request<MergePersonsResult>(
      "mergePersons",
      { targetPersonId, sourcePersonId }
    );
  }

  async renamePerson(
    personId: number,
    name: string
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "renamePerson",
      { personId, name }
    );
  }
}
