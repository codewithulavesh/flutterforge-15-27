/**
 * Data Models Agent — generates real, typed Dart model classes for the app.
 * This runs BEFORE frontend/backend agents so screens can import proper models.
 */
import type { ProjectState, GeneratedFile } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

export async function runDataModelsAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const appName = state.productBrief?.appName || 'App';
  const pkgName = appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  const brief = state.productBrief;
  const screens = state.screenGraph?.screens || [];
  const arch = state.architectureSpec || state.architecture;
  const intake = state._intakeData as Record<string, unknown> | undefined;
  const domain = (intake?.domain as string) || 'general';
  const keyFeatures = (intake?.keyFeatures as string[]) || [];
  const needsSupabase = arch?.backendMode === 'supabase';
  const files = new Map<string, GeneratedFile>(state.generatedFiles);

  let raw = '';
  try {
    raw = await callLLMText(
      [
        {
          role: 'system',
          content: `You are a senior Dart/Flutter architect generating PRODUCTION-QUALITY model classes.

STRICT RULES:
1. Every model is an immutable Dart class with final fields
2. Include fromJson(Map<String,dynamic>) factory constructor
3. Include toJson() Map<String,dynamic> method
4. Include copyWith(...) method for immutable updates
5. Include proper == operator and hashCode override
6. Include toString() override
7. Use proper Dart types: String, int, double, bool, DateTime, List<T>, Map<String,dynamic>
8. DateTime fields: use DateTime.parse(json['field']) and .toIso8601String() in toJson
9. Nullable fields: use String? with json['field'] as String?
10. Enums: define as proper Dart enums with values
11. Models must be real domain objects — NOT generic "Item" or "Record"
12. Each model in its own file under lib/core/models/

For a ${domain} app, generate ALL domain models needed.

Output format — EXACT separator for each file:
// FILE: lib/core/models/user_model.dart
\`\`\`dart
// full Dart code
\`\`\`

// FILE: lib/core/models/product_model.dart  
\`\`\`dart
// full Dart code
\`\`\``,
        },
        {
          role: 'user',
          content: `Generate ALL Dart model classes for "${appName}" — a ${domain} app.

App description: ${brief?.oneLiner}
Key features: ${keyFeatures.join(', ')}
Screens: ${screens.map((s) => `${s.name}: ${s.purpose}`).join('; ')}
Needs Supabase: ${needsSupabase}
Package name: ${pkgName}

Domain context: ${domain}

For a ${domain} app specifically generate models like:
${getDomainModelHints(domain)}

Also generate:
- UserModel / ProfileModel (always)
- Any model needed for each screen's data

Make models REAL and domain-specific. Each field should make sense for a real ${domain} app.
No generic "Item" or "Data" model names.`,
        },
      ],
      { model: agentModelFor('data-models'), temperature: 0.2, maxTokens: 6000 }
    );
  } catch (err) {
    console.warn('[DataModelsAgent] LLM failed, using domain fallbacks:', err);
    raw = '';
  }

  const parsed = parseFilesFromLLMOutput(raw);
  for (const f of parsed) {
    const cleanContent = f.content.replace(/^```(?:dart)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    if (cleanContent.length > 30) {
      files.set(f.path, { path: f.path, action: 'created', language: 'dart', content: cleanContent });
    }
  }

  // Always ensure a base user model exists
  if (!files.has('lib/core/models/user_model.dart')) {
    files.set('lib/core/models/user_model.dart', {
      path: 'lib/core/models/user_model.dart',
      action: 'created',
      language: 'dart',
      content: generateUserModelFallback(pkgName),
    });
  }

  const modelCount = [...files.keys()].filter((k) => k.includes('/models/')).length;

  return {
    generatedFiles: files,
    _modelFiles: [...files.keys()].filter((k) => k.includes('/models/')),
    logs: [
      ...state.logs,
      `[Data Models Agent] Generated ${modelCount} domain model classes: ${[...files.keys()].filter((k) => k.includes('/models/')).map((k) => k.split('/').pop()?.replace('.dart', '')).join(', ')}`,
    ],
  };
}

function getDomainModelHints(domain: string): string {
  const hints: Record<string, string> = {
    ecommerce: `- ProductModel (id, name, description, price, imageUrl, category, rating, stockCount, isFavorite)
- CartItemModel (product, quantity, totalPrice)
- OrderModel (id, items, totalAmount, status, createdAt, deliveryAddress)
- CategoryModel (id, name, iconUrl, productCount)
- ReviewModel (id, userId, productId, rating, comment, createdAt)
- AddressModel (id, street, city, state, country, zipCode, isDefault)`,
    fitness: `- WorkoutModel (id, name, description, duration, caloriesBurned, exercises, difficulty)
- ExerciseModel (id, name, sets, reps, weight, restSeconds, muscleGroup, imageUrl)
- WorkoutLogModel (id, workoutId, completedAt, actualDuration, notes)
- GoalModel (id, type, targetValue, currentValue, deadline, isCompleted)
- NutritionModel (id, name, calories, protein, carbs, fats, servingSize)
- StreakModel (currentStreak, longestStreak, lastWorkoutDate)`,
    tasks: `- TaskModel (id, title, description, priority, status, dueDate, tags, assigneeId, projectId)
- ProjectModel (id, name, description, color, memberIds, taskCount, completedCount)
- TagModel (id, name, color)
- CommentModel (id, taskId, userId, content, createdAt)
- SubtaskModel (id, taskId, title, isCompleted)`,
    social: `- PostModel (id, userId, content, imageUrls, likesCount, commentsCount, createdAt, isLiked)
- UserProfileModel (id, username, fullName, bio, avatarUrl, followersCount, followingCount, postsCount)
- CommentModel (id, postId, userId, content, likesCount, createdAt)
- NotificationModel (id, type, fromUserId, postId, message, isRead, createdAt)
- MessageModel (id, senderId, receiverId, content, imageUrl, sentAt, isRead)`,
    finance: `- TransactionModel (id, amount, type, category, note, date, accountId, isRecurring)
- AccountModel (id, name, type, balance, currency, color, icon)
- CategoryModel (id, name, icon, color, budget, spent, type)
- BudgetModel (id, categoryId, amount, spent, period, startDate, endDate)
- GoalModel (id, name, targetAmount, currentAmount, deadline, icon)
- RecurringModel (id, transactionTemplate, frequency, nextDate, isActive)`,
    food: `- RecipeModel (id, name, description, imageUrl, ingredients, steps, cookTime, servings, calories, rating)
- IngredientModel (name, amount, unit)
- MealPlanModel (id, date, breakfast, lunch, dinner, snacks)
- RestaurantModel (id, name, cuisine, rating, deliveryTime, minOrder, imageUrl)
- OrderModel (id, restaurantId, items, totalAmount, status, estimatedTime)`,
    music: `- TrackModel (id, title, artist, album, duration, imageUrl, audioUrl, genre, isFavorite)
- AlbumModel (id, title, artist, year, imageUrl, tracks, totalDuration)
- PlaylistModel (id, name, tracks, createdBy, isPublic, imageUrl)
- ArtistModel (id, name, imageUrl, monthlyListeners, genres, albums)`,
    travel: `- TripModel (id, destination, startDate, endDate, budget, notes, itinerary, coverImageUrl)
- ItineraryItemModel (id, tripId, day, time, activity, location, notes)
- HotelModel (id, name, location, rating, pricePerNight, imageUrl, amenities)
- FlightModel (id, from, to, departureTime, arrivalTime, airline, price, seatClass)
- PackingItemModel (id, tripId, name, category, isPacked)`,
    education: `- CourseModel (id, title, instructor, description, imageUrl, duration, lessons, rating, enrolled)
- LessonModel (id, courseId, title, duration, videoUrl, isCompleted, order)
- QuizModel (id, lessonId, questions)
- QuestionModel (id, text, options, correctIndex, explanation)
- ProgressModel (courseId, completedLessons, totalLessons, lastAccessedAt)`,
    general: `- ItemModel (id, title, description, imageUrl, createdAt, updatedAt, isActive)
- CategoryModel (id, name, icon, color, itemCount)
- NotificationModel (id, title, body, type, isRead, createdAt)
- SettingsModel (theme, language, notifications, biometrics)`,
  };
  return hints[domain] || hints['general'];
}

function generateUserModelFallback(pkgName: string): string {
  return `import 'package:flutter/foundation.dart';

@immutable
class UserModel {
  final String id;
  final String email;
  final String? fullName;
  final String? avatarUrl;
  final DateTime createdAt;
  final DateTime updatedAt;

  const UserModel({
    required this.id,
    required this.email,
    this.fullName,
    this.avatarUrl,
    required this.createdAt,
    required this.updatedAt,
  });

  factory UserModel.fromJson(Map<String, dynamic> json) {
    return UserModel(
      id: json['id'] as String,
      email: json['email'] as String,
      fullName: json['full_name'] as String?,
      avatarUrl: json['avatar_url'] as String?,
      createdAt: DateTime.parse(json['created_at'] as String),
      updatedAt: DateTime.parse(json['updated_at'] as String),
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'email': email,
    'full_name': fullName,
    'avatar_url': avatarUrl,
    'created_at': createdAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
  };

  UserModel copyWith({
    String? id,
    String? email,
    String? fullName,
    String? avatarUrl,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return UserModel(
      id: id ?? this.id,
      email: email ?? this.email,
      fullName: fullName ?? this.fullName,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) || other is UserModel && other.id == id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'UserModel(id: \$id, email: \$email, fullName: \$fullName)';
}
`;
}
