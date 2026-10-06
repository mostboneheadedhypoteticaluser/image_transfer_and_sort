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

const ALGORITHM_VERSION = "person-centroid-v1";

type ClusterWorkerResult = {
  algorithm: string;
  clusterThreshold: number;
  verificationThreshold: number;
  clusterCount: number;
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
    allowWhilePending = false
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

      if (forceRefresh || set.needsRebuild) {
        const clustered = await this.analysis.request<ClusterWorkerResult>(
          "cluster_face_embeddings",
          {
            faces: set.faces,
            cannotLinks: set.cannotLinks,
            clusterThreshold: 0.50,
            verificationThreshold: 0.363
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
          writtenItems: replaced.writtenFaces
        });

        if (replaced.writtenFaces !== set.faces.length) {
          throw new Error(
            "Personengruppierung hat " +
            set.faces.length +
            " gültige Gesichtsmerkmale erhalten, aber nur " +
            replaced.writtenFaces +
            " Gesichter in Kandidaten gespeichert."
          );
        }
      }
    }

    const [candidates, persons, stats] = await Promise.all([
      this.catalog.request<PersonCandidate[]>("listPersonCandidates", {
        sourceId,
        // Neue Gruppen müssen bei großen Katalogen sichtbar bleiben. Die DB
        // liefert sie neueste-zuerst; 500 hält DOM/Payload trotzdem begrenzt.
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
      candidateFaceTotal: stats.personCandidateFaces
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
      overviews.push(await this.getOverview(source.id, forceRefresh, false));
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
          b.newestFaceId - a.newestFaceId ||
          b.faceCount - a.faceCount ||
          b.averageSimilarity - a.averageSimilarity
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
    name: string
  ): Promise<ConfirmPersonResult> {
    return this.catalog.request<ConfirmPersonResult>(
      "confirmPersonCandidate",
      { candidateId, name }
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
